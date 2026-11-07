{
  "AWSEBDockerrunVersion": 2,
  "executionRoleArn": "${EXECUTION_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "app",
      "image": "${IMAGE_URI}",
      "essential": true,
      "memory": 512,
      "portMappings": [
        {
          "hostPort": 80,
          "containerPort": 8080
        }
      ]
    }
  ]
}
