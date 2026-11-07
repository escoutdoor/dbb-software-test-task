# DBB Software DevOps test task: Dockerized app on AWS Elastic Beanstalk

A small Flask service, deployed as a Docker container to AWS Elastic Beanstalk (ECS-managed Docker platform), with infrastructure defined in AWS CDK (TypeScript) and a GitHub Actions pipeline.

```
Internet -> ALB (80) -> EC2 instance, container :8080 (Beanstalk, ECS platform) -> RDS PostgreSQL (private)
```

| Endpoint | Method | Status | Response |
|---|---|---|---|
| `/health` | GET | 200 | `{"status":"healthy"}` |
| `/db-test` | GET | 200 | `{"db":"connected"}` |
| `/db-test` | GET | 503 | `{"db":"unreachable"}` |

## Repository layout

```
app/                    Flask application, Dockerfile
eb/                     Dockerrun.aws.json template (shared by CDK and CI)
infrastructure/         AWS CDK project (TypeScript)
.github/                CI/CD workflow
docs/screenshots/
```

## Configuration

Before deploying, edit [`infrastructure/lib/config.ts`](./infrastructure/lib/config.ts) and set:

| Field | Description |
| --- | --- |
| `applicationName` | Beanstalk application name and resource prefix. |
| `environmentName` | Beanstalk environment name. |
| `repositoryName`  | ECR repository name. |
| `dbSecretName`    | Secrets Manager secret name for the RDS credentials. |
| `executionRoleName` | ECS task execution role name (referenced in Dockerrun.aws.json). |
| `solutionStackName` | Beanstalk platform version. |
| `githubRepository` | owner/repo of the GitHub repository allowed to assume the CI role. |
| `githubOrgId` | Numeric ID of the repository owner, user or organization (Settings → Actions → OIDC). | 
| `githubRepoId` | Numeric ID of the repository (same page). |
| `environment` | Tag value for Environment (e.g. test, prod). |

Repositories now use an immutable `sub` claim that includes these numeric IDs, so they are required for the CI role's trust policy.

## What CDK creates

- **EcrStack**: ECR repository (scan on push, immutable tags, keeps the last 10 images).
- **BeanstalkStack**:
  - VPC with 2 AZs, public subnets for the load balancer and instances, isolated subnets for the database, no NAT gateway.
  - Security groups: the load balancer accepts HTTP (80) from the internet, instances accept 80 only from the load balancer, the database accepts 5432 only from the instances.
  - RDS PostgreSQL 17 (`db.t4g.micro`, encrypted, not public). The password is generated in Secrets Manager.
  - IAM: instance profile, service role and an ECS task execution role. The instance profile and the task execution role can read only the database secret, which reaches the container as the `DB_SECRET` environment variable (Beanstalk environment secrets).
  - Elastic Beanstalk application (keeps the last 50 versions) and environment (`64bit Amazon Linux 2023 ... running ECS`) with a health check on `/health`.
  - An S3 bucket for the deployment bundles uploaded by the pipeline.
  - A GitHub OIDC provider and a role that the pipeline assumes (no stored AWS keys). Only the `main` branch of the configured repository can assume the role.
- Every resource is tagged with `Project`, `ManagedBy` and `Environment`.

The container listens on 8080. The Dockerrun file maps it to host port 80, which the load balancer targets.

## Deploy the infrastructure

Prerequisites: AWS CLI with credentials and a default region, Node.js 22+, Docker, Git.

```bash
cd infrastructure
npm ci

# Once per account and region
npx cdk bootstrap

# 1. Create the ECR repository
npx cdk deploy EcrStack

# 2. Build and push the first image (tags are immutable, so use the commit SHA)
TAG=$(git rev-parse HEAD)

# CDK deploys to the default region of your AWS profile, so use the same one here
REGION=$(aws configure get region)

REGISTRY=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.${REGION}.amazonaws.com
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

docker build --platform linux/amd64 --tag "$REGISTRY/dbb-software-test-task-app:$TAG" ../app
docker push "$REGISTRY/dbb-software-test-task-app:$TAG"

# 3. Create the network, database and Beanstalk environment
npx cdk deploy BeanstalkStack -c imageTag="$TAG"
```

`BeanstalkStack` exists only when `-c imageTag=...` is passed, because it deploys one specific image.

### GitHub OIDC provider

An AWS account can have only one OIDC provider for `token.actions.githubusercontent.com`, so creating a second one fails. Check whether the account already has one:

```bash
aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')].Arn" \
  --output text
```

If this prints an ARN, pass it in step 3 so the stack reuses the provider:

```bash
npx cdk deploy BeanstalkStack -c imageTag="$TAG" -c githubOidcProviderArn=<arn-from-the-command-above>
```

A provider created by this stack is deleted by `cdk destroy`. A reused provider is left untouched, so other projects that rely on it keep working.

### Optional context values

| Context | Purpose |
| --- | --- |
| `-c githubOidcProviderArn=arn:...` | Reuse an existing GitHub OIDC provider (see above) |
| `-c solutionStackName="..."` | Use another Beanstalk platform version |

List the current ECS platform versions with:

```bash
aws elasticbeanstalk list-available-solution-stacks --output text | tr "\t" "\n" | grep "running ECS"
```

The first environment creation takes about 10 minutes. The stack outputs print the environment URL, the database endpoint, the CI role ARN and the bundle bucket name.

## Check the application

The `EnvironmentUrl` output already includes `http://`.

```bash
URL=$(aws cloudformation describe-stacks --stack-name BeanstalkStack \
  --query "Stacks[0].Outputs[?OutputKey=='EnvironmentUrl'].OutputValue" --output text)

curl "$URL/health"
curl "$URL/db-test"
```

Sample output:

```
{"status":"healthy"}
{"db":"connected"}
```

Run it locally with Docker. Without the `DB_SECRET` environment variable set, `/db-test` returns `503` with `{"db":"unreachable"}` (the app catches `KeyError` and logs the missing secret):

```bash
docker build --tag dbb-software-test-task-app app
docker run --rm --publish 8080:8080 dbb-software-test-task-app
curl localhost:8080/health
```

### Screenshots

See [`/docs/screenshots`](./docs/screenshots/):

Elastic Beanstalk's ECS platform creates an ECS cluster and runs the containers as tasks on it; it does not create an ECS service, so the screenshot shows the running tasks.

* ecs-tasks.png — ECS tasks running under the Beanstalk cluster.
* rds.png — RDS instance, Available.
* health.png — curl /health output.
* db-test.png — curl /db-test output.

## CI/CD

`.github/workflows/deploy.yml` runs on every push to `main` that touches `app/`, `eb/` or the workflow itself:

1. Assume the AWS role through GitHub OIDC.
2. Build the image, tag it with the commit SHA and push it to ECR (skipped if the tag already exists).
3. Render `eb/Dockerrun.aws.json.tpl`, upload the bundle to S3 and create an application version.
4. Update the Beanstalk environment, wait until it is ready (15 minutes at most) and check that the new version is the deployed one.
5. Smoke test `/health` and `/db-test`.

Setup after the first deploy: in the GitHub repository open Settings, Secrets and variables, Actions, Variables, and add:

- `AWS_REGION`: the region you deployed to.
- `AWS_ROLE_ARN`: the `GithubActionsRoleArn` stack output.

Use the pipeline for application updates and CDK for infrastructure changes. Running `cdk deploy` with an `imageTag` different from the previous one makes Beanstalk deploy that image.

## Clean up

The load balancer, EC2 instance and RDS instance cost money while they run.

```bash
cd infrastructure

# Any non-empty tag works: it only makes BeanstalkStack part of the app
npx cdk destroy --all -c imageTag=destroy
```

## Production notes

This is a demo configuration. For production:

- Add an ACM certificate and an HTTPS listener. Beanstalk creates the HTTP (80) listener by default, but the HTTPS (443) listener must be added explicitly with a certificate ARN through `aws:elbv2:listener:443` option settings, and port 443 opened on the load balancer security group (it is closed here because there is no certificate).
- Enable RDS Multi-AZ, deletion protection and longer backup retention, and remove the `DESTROY` removal policies.
- Add NAT gateways or VPC endpoints and move the instances into private subnets.
- The CI role currently uses the AWS-managed `AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy` for S3 bucket operations during `UpdateEnvironment`. This is the broadest permission in the project and should be scoped to specific `elasticbeanstalk-*` bucket ARNs once the deployment flow is stable.
