#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { BeanstalkStack } from "../lib/beanstalk-stack";
import { config } from "../lib/config";
import { EcrStack } from "../lib/ecr-stack";

const app = new cdk.App();

const env: cdk.Environment = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
};
if (!env.account || !env.region) {
    throw new Error("AWS account and region are not resolved. Configure AWS credentials and a default region.");
}

cdk.Tags.of(app).add("Project", config.applicationName);
cdk.Tags.of(app).add("ManagedBy", "cdk");
cdk.Tags.of(app).add("Environment", config.environment);

const ecrStack = new EcrStack(app, "EcrStack", { env });

const imageTag = app.node.tryGetContext("imageTag") as string | undefined;
if (imageTag) {
    new BeanstalkStack(app, "BeanstalkStack", {
        env,
        repository: ecrStack.repository,
        imageTag,
        githubRepository: config.githubRepository,
        githubOrgId: config.githubOrgId,
        githubRepoId: config.githubRepoId,
        existingOidcProviderArn: app.node.tryGetContext("githubOidcProviderArn") as string | undefined,
    });
}
