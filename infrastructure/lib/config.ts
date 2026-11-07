// Names shared between the CDK code and the GitHub Actions workflow.
export const config = {
    applicationName: "dbb-software-test-task",
    environmentName: "dbb-software-test-task-env",
    repositoryName: "dbb-software-test-task-app",
    dbSecretName: "dbb-software-test-task/db",
    executionRoleName: "dbb-software-test-task-exec",
    // Override with: cdk deploy -c solutionStackName="..."
    solutionStackName: "64bit Amazon Linux 2023 v4.8.1 running ECS",
    // Override with: cdk deploy -c githubRepository=owner/repo
    githubRepository: "escoutdoor/dbb-software-test-task",

    environment: "test",
} as const;
