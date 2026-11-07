import * as cdk from "aws-cdk-lib/core";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { config } from "./config";

interface GithubActionsRoleProps {
    repository: ecr.IRepository;
    bundleBucket: s3.IBucket;
    githubRepository: string;
    // Set when the account already has a GitHub OIDC provider (only one per account is allowed).
    existingOidcProviderArn?: string;
}

const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";

export class GithubActionsRole extends Construct {
    public readonly role: iam.Role;

    constructor(scope: Construct, id: string, props: GithubActionsRoleProps) {
        super(scope, id);

        const provider = props.existingOidcProviderArn
            ? iam.OidcProviderNative.fromOidcProviderArn(this, "Provider", props.existingOidcProviderArn)
            : new iam.OidcProviderNative(this, "Provider", {
                url: `https://${GITHUB_OIDC_HOST}`,
                clientIds: ["sts.amazonaws.com"],
            });

        // We restrict that only workflows on the main branch of this repository can assume the role.
        this.role = new iam.Role(this, "Role", {
            description: "Assumed by GitHub Actions to push images and deploy to Elastic Beanstalk",
            assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
                StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: "sts.amazonaws.com" },
                StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: `repo:${props.githubRepository}:ref:refs/heads/main` },
            }),
        });

        props.repository.grantPullPush(this.role);
        props.bundleBucket.grantReadWrite(this.role);

        const stack = cdk.Stack.of(this);
        const application = stack.formatArn({
            service: "elasticbeanstalk",
            resource: "application",
            resourceName: config.applicationName,
        });
        const applicationVersions = stack.formatArn({
            service: "elasticbeanstalk",
            resource: "applicationversion",
            resourceName: `${config.applicationName}/*`,
        });
        const environment = stack.formatArn({
            service: "elasticbeanstalk",
            resource: "environment",
            resourceName: `${config.applicationName}/${config.environmentName}`,
        });

        this.role.addToPolicy(
            new iam.PolicyStatement({
                actions: ["elasticbeanstalk:CreateApplicationVersion", "elasticbeanstalk:UpdateEnvironment"],
                resources: [application, applicationVersions, environment],
            }),
        );

        // Describe calls do not support resource-level permissions.
        this.role.addToPolicy(
            new iam.PolicyStatement({
                actions: [
                    "elasticbeanstalk:DescribeApplicationVersions",
                    "elasticbeanstalk:DescribeEnvironments",
                    "elasticbeanstalk:DescribeEvents",
                ],
                resources: ["*"],
            }),
        );
    }
}
