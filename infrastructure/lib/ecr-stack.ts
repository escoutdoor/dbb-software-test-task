import * as cdk from "aws-cdk-lib/core";
import * as ecr from "aws-cdk-lib/aws-ecr";
import { Construct } from "constructs";
import { config } from "./config";

export class EcrStack extends cdk.Stack {
    public readonly repository: ecr.Repository;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Immutable tags make every deployment traceable to one image.
        this.repository = new ecr.Repository(this, "Repository", {
            repositoryName: config.repositoryName,
            imageScanOnPush: true,
            imageTagMutability: ecr.TagMutability.IMMUTABLE,
            lifecycleRules: [{ description: "keep the last 10 images", maxImageCount: 10 }],
            // Test setting: both options destroy the repository with all images on `cdk destroy`.
            // For production use removalPolicy: RETAIN (and drop emptyOnDelete) to preserve images.
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            emptyOnDelete: true,
        });

        new cdk.CfnOutput(this, "RepositoryUri", { value: this.repository.repositoryUri });
        new cdk.CfnOutput(this, "RepositoryName", { value: this.repository.repositoryName });
        new cdk.CfnOutput(this, "RepositoryArn", { value: this.repository.repositoryArn });
    }
}
