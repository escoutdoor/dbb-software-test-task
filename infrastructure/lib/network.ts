import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

export class Network extends Construct {
    public readonly vpc: ec2.Vpc;
    public readonly loadBalancerSecurityGroup: ec2.SecurityGroup;
    public readonly instanceSecurityGroup: ec2.SecurityGroup;
    public readonly databaseSecurityGroup: ec2.SecurityGroup;

    constructor(scope: Construct, id: string) {
        super(scope, id);

        // No NAT gateways: instances use public IPs, the database stays isolated.
        this.vpc = new ec2.Vpc(this, "Vpc", {
            maxAzs: 2,
            natGateways: 0,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnetConfiguration: [
                { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
                { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
            ],
        });

        this.loadBalancerSecurityGroup = new ec2.SecurityGroup(this, "LoadBalancerSecurityGroup", {
            vpc: this.vpc,
            description: "Public HTTP access to the load balancer",
        });
        // Only HTTP is open: there is no ACM certificate, so the load balancer has no HTTPS listener
        this.loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.HTTP, "HTTP from the internet");

        // Instances must reach ECR, S3 and Secrets Manager, so outbound stays open.
        this.instanceSecurityGroup = new ec2.SecurityGroup(this, "InstanceSecurityGroup", {
            vpc: this.vpc,
            description: "Beanstalk instances, reachable only from the load balancer",
        });
        this.instanceSecurityGroup.addIngressRule(
            this.loadBalancerSecurityGroup,
            ec2.Port.HTTP,
            "HTTP from the load balancer",
        );

        this.databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
            vpc: this.vpc,
            description: "Reachable only from Beanstalk instances",
            allowAllOutbound: false,
        });
        this.databaseSecurityGroup.addIngressRule(
            this.instanceSecurityGroup,
            ec2.Port.POSTGRES,
            "PostgreSQL from Beanstalk instances",
        );
    }
}
