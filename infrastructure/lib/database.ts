import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { config } from "./config";

interface DatabaseProps {
    vpc: ec2.IVpc;
    securityGroup: ec2.ISecurityGroup;
}

export class Database extends Construct {
    public readonly instance: rds.DatabaseInstance;
    public readonly secret: secretsmanager.ISecret;

    constructor(scope: Construct, id: string, props: DatabaseProps) {
        super(scope, id);

        // Demo settings: destroyed with the stack. Enable deletionProtection, Multi-AZ and RETAIN for production.
        this.instance = new rds.DatabaseInstance(this, "Instance", {
            engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
            vpc: props.vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
            securityGroups: [props.securityGroup],
            databaseName: "app",
            credentials: rds.Credentials.fromGeneratedSecret("app", { secretName: config.dbSecretName }),
            allocatedStorage: 20,
            storageEncrypted: true,
            deletionProtection: false,
            multiAz: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Generated secret JSON includes host, port, dbname, username and password.
        this.secret = this.instance.secret!;
    }
}
