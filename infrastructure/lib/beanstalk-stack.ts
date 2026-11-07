import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib/core";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elasticbeanstalk from "aws-cdk-lib/aws-elasticbeanstalk";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { config } from "./config";
import { Database } from "./database";
import { GithubActionsRole } from "./gh-actions-role";
import { Network } from "./network";

interface BeanstalkStackProps extends cdk.StackProps {
    repository: ecr.IRepository;
    imageTag: string;
    githubRepository: string;
    githubOrgId: string;
    githubRepoId: string;
    existingOidcProviderArn?: string;
}

export class BeanstalkStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: BeanstalkStackProps) {
        super(scope, id, props);

        if (cdk.Token.isUnresolved(this.account) || cdk.Token.isUnresolved(this.region)) {
            throw new Error("BeanstalkStack needs an explicit AWS account and region.");
        }

        const network = new Network(this, "Network");
        const database = new Database(this, "Database", {
            vpc: network.vpc,
            securityGroup: network.databaseSecurityGroup,
        });

        const sourceBundle = this.createSourceBundle(props.imageTag);

        // Bundles uploaded by the CI pipeline for later deployments.
        const bundleBucket = new s3.Bucket(this, "BundleBucket", {
            bucketName: `${config.applicationName}-bundles-${this.account}-${this.region}`,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: s3.BucketEncryption.S3_MANAGED,
            enforceSSL: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        const instanceRole = new iam.Role(this, "InstanceRole", {
            assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("AWSElasticBeanstalkWebTier"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AWSElasticBeanstalkMulticontainerDocker"),
            ],
        });
        props.repository.grantPull(instanceRole);
        database.secret.grantRead(instanceRole);
        sourceBundle.grantRead(instanceRole);
        bundleBucket.grantRead(instanceRole);
        const instanceProfile = new iam.InstanceProfile(this, "InstanceProfile", { role: instanceRole });

        // The ECS agent uses this role to read the database secret at container start.
        const executionRole = new iam.Role(this, "TaskExecutionRole", {
            roleName: config.executionRoleName,
            assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
            ],
        });
        database.secret.grantRead(executionRole);
        instanceRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ["iam:PassRole"],
                resources: [executionRole.roleArn],
                conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
            }),
        );

        const serviceRole = new iam.Role(this, "ServiceRole", {
            assumedBy: new iam.ServicePrincipal("elasticbeanstalk.amazonaws.com"),
            externalIds: ["elasticbeanstalk"],
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSElasticBeanstalkEnhancedHealth"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy"),
            ],
        });

        const application = new elasticbeanstalk.CfnApplication(this, "Application", {
            applicationName: config.applicationName,
            resourceLifecycleConfig: {
                serviceRole: serviceRole.roleArn,
                versionLifecycleConfig: {
                    maxCountRule: { enabled: true, maxCount: 50, deleteSourceFromS3: false },
                },
            },
        });

        const applicationVersion = new elasticbeanstalk.CfnApplicationVersion(this, "ApplicationVersion", {
            applicationName: application.ref,
            sourceBundle: { s3Bucket: sourceBundle.s3BucketName, s3Key: sourceBundle.s3ObjectKey },
        });

        const publicSubnetIds = network.vpc.publicSubnets.map((subnet) => subnet.subnetId).join(",");
        const solutionStackName =
            (this.node.tryGetContext("solutionStackName") as string | undefined) ?? config.solutionStackName;

        const environment = new elasticbeanstalk.CfnEnvironment(this, "Environment", {
            applicationName: application.ref,
            environmentName: config.environmentName,
            solutionStackName,
            versionLabel: applicationVersion.ref,
            optionSettings: [
                { namespace: "aws:autoscaling:launchconfiguration", optionName: "IamInstanceProfile", value: instanceProfile.instanceProfileName },
                { namespace: "aws:autoscaling:launchconfiguration", optionName: "SecurityGroups", value: network.instanceSecurityGroup.securityGroupId },
                { namespace: "aws:ec2:instances", optionName: "InstanceTypes", value: "t3.micro" },
                { namespace: "aws:autoscaling:asg", optionName: "MinSize", value: "1" },
                { namespace: "aws:autoscaling:asg", optionName: "MaxSize", value: "2" },
                { namespace: "aws:ec2:vpc", optionName: "VPCId", value: network.vpc.vpcId },
                { namespace: "aws:ec2:vpc", optionName: "Subnets", value: publicSubnetIds },
                { namespace: "aws:ec2:vpc", optionName: "ELBSubnets", value: publicSubnetIds },
                { namespace: "aws:ec2:vpc", optionName: "AssociatePublicIpAddress", value: "true" },
                { namespace: "aws:elasticbeanstalk:environment", optionName: "EnvironmentType", value: "LoadBalanced" },
                { namespace: "aws:elasticbeanstalk:environment", optionName: "LoadBalancerType", value: "application" },
                { namespace: "aws:elasticbeanstalk:environment", optionName: "ServiceRole", value: serviceRole.roleArn },
                { namespace: "aws:elbv2:loadbalancer", optionName: "SecurityGroups", value: network.loadBalancerSecurityGroup.securityGroupId },
                { namespace: "aws:elbv2:loadbalancer", optionName: "ManagedSecurityGroup", value: network.loadBalancerSecurityGroup.securityGroupId },
                { namespace: "aws:elasticbeanstalk:environment:process:default", optionName: "Port", value: "80" },
                { namespace: "aws:elasticbeanstalk:environment:process:default", optionName: "Protocol", value: "HTTP" },
                { namespace: "aws:elasticbeanstalk:environment:process:default", optionName: "HealthCheckPath", value: "/health" },
                { namespace: "aws:elasticbeanstalk:healthreporting:system", optionName: "SystemType", value: "enhanced" },
                { namespace: 'aws:elasticbeanstalk:application:environmentsecrets', optionName: 'DB_SECRET', value: database.secret.secretArn },
            ],
        });
        // The container reads the secret on start, so the database must exist first.
        environment.node.addDependency(database);

        const githubActionsRole = new GithubActionsRole(this, 'GithubActionsRole', {
            repository: props.repository,
            bundleBucket,
            githubRepository: props.githubRepository,
            githubOrgId: props.githubOrgId,
            githubRepoId: props.githubRepoId,
            existingOidcProviderArn: props.existingOidcProviderArn,
        });

        new cdk.CfnOutput(this, "EnvironmentUrl", { value: `http://${environment.attrEndpointUrl}` });
        new cdk.CfnOutput(this, "DatabaseEndpoint", { value: database.instance.dbInstanceEndpointAddress });
        new cdk.CfnOutput(this, "GithubActionsRoleArn", { value: githubActionsRole.role.roleArn });
        new cdk.CfnOutput(this, "BundleBucketName", { value: bundleBucket.bucketName });
    }

    // Renders eb/Dockerrun.aws.json.tpl into a one-file bundle that Beanstalk deploys.
    private createSourceBundle(imageTag: string): s3assets.Asset {
        const templatePath = path.join(__dirname, "..", "..", "eb", "Dockerrun.aws.json.tpl");
        const template = fs.readFileSync(templatePath, "utf8");

        const values: Record<string, string> = {
            IMAGE_URI: `${this.account}.dkr.ecr.${this.region}.amazonaws.com/${config.repositoryName}:${imageTag}`,
            EXECUTION_ROLE_ARN: `arn:aws:iam::${this.account}:role/${config.executionRoleName}`,
        };
        const rendered = template.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
            const value = values[key];
            if (value === undefined) {
                throw new Error(`Unknown placeholder in Dockerrun template: ${key}`);
            }
            return value;
        });

        const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "dockerrun-"));
        fs.writeFileSync(path.join(bundleDir, "Dockerrun.aws.json"), rendered);
        return new s3assets.Asset(this, "SourceBundle", { path: bundleDir });
    }
}
