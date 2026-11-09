# Continuous deployment for AWS Lambda Web Functions with AWS CodePipeline

This pattern releases a Lambda Web Function from a Git commit. A push to the tracked branch of a GitHub repository runs AWS CodeBuild, which packages the application, uploads it to Amazon S3 as a new object version, creates an immutable revision of the Web Function, and shifts the endpoint's revision weights to it.

Web Functions read code only from a versioning-enabled S3 bucket. AWS SAM packages the first revision when you deploy the stack, but releasing each commit needs this glue, which every team adopting Web Functions has to build. Here it is built from AWS services, which keeps the release history in the account rather than in a developer's shell.

Learn more about this pattern at Serverless Land Patterns: << Add the live URL here >>

Important: this application uses various AWS services and there are costs associated with these services after the Free Tier usage - please see the [AWS Pricing page](https://aws.amazon.com/pricing/) for details. You are responsible for any AWS costs incurred. No warranty is implied in this example.

## Requirements

* [Create an AWS account](https://portal.aws.amazon.com/gp/aws/developer/registration/index.html) if you do not already have one and log in. The IAM user that you use must have sufficient permissions to make necessary AWS service calls and manage AWS resources.
* [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) version 2.37 or later, installed and configured. Earlier versions have no `aws lambda-web` commands.
* [Git Installed](https://git-scm.com/book/en/v2/Getting-Started-Installing-Git)
* [Node.js](https://nodejs.org/en/download/) 24 (matches the `nodejs24.x` runtime)
* [AWS Serverless Application Model](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html) (AWS SAM) installed, version 1.171.0 or later (`sam --version`)
* A GitHub repository you can push to, which holds the application code

## Deployment Instructions

1. Create a new directory, navigate to that directory in a terminal and clone the GitHub repository:
    ```
    git clone https://github.com/aws-samples/serverless-patterns
    ```
1. Change directory to the pattern directory:
    ```
    cd lambda-web-codepipeline/nodejs/sam
    ```
1. Push the application to your own GitHub repository. The pipeline builds whatever is at the root of that repository, so `index.js` must be at the root:
    ```bash
    cp src/index.js src/package.json /path/to/your-repo/
    (cd /path/to/your-repo && git add index.js package.json \
      && git commit -m "Add web function app" && git push)
    ```
1. Create an AWS CodeConnections connection to GitHub. AWS CloudFormation cannot create one because it needs a browser handshake, and a connection left in `PENDING` will not work:
    ```bash
    export AWS_REGION=<< AWS Region >>
    export STACK=lambda-web-codepipeline
    aws codeconnections create-connection --provider-type GitHub \
      --connection-name $STACK --region $AWS_REGION
    ```
    Open the [Connections console](https://console.aws.amazon.com/codesuite/settings/connections), choose the connection, complete **Update pending connection**, then confirm it is `AVAILABLE` and export its ARN:
    ```bash
    export CONNECTION_ARN=<< connection ARN >>
    aws codeconnections get-connection --connection-arn $CONNECTION_ARN \
      --region $AWS_REGION --query ConnectionStatus
    ```
1. Build the application. `CodeUri` is the local `src/` directory, so the AWS SAM CLI packages it for the revision the stack creates:
    ```bash
    sam build
    ```
1. Deploy the stack:
    ```bash
    sam deploy \
      --stack-name $STACK \
      --capabilities CAPABILITY_IAM \
      --region $AWS_REGION \
      --resolve-s3 \
      --parameter-overrides \
        ConnectionArn=$CONNECTION_ARN \
        RepositoryId=<< owner/name >> \
        BranchName=main
    ```
    `EndpointAuthType` defaults to `IamAuth`, so the endpoint accepts only SigV4-signed requests. Pass `EndpointAuthType=ApplicationManaged` to make it public, which leaves authentication to the application; the sample application does not authenticate anyone.
1. Note the `EndpointDomainName` output. The endpoint can take a couple of minutes to become `Active` on a first deploy.

## How it works

* The single `AWS::Serverless::WebFunction` in `template.yaml` expands into three CloudFormation resources:
  * `AWS::Lambda::WebFunction`: the function itself
  * `AWS::Lambda::WebFunctionRevision`: an immutable snapshot of code + configuration
  * `AWS::Lambda::WebFunctionEndpoint`: the HTTPS endpoint, routed 100% to that revision
* `sam deploy` uploads the first revision's code to a bucket the AWS SAM CLI creates in a separate `<stack>-<hash>-WebFunctionCode` stack. The pipeline uploads every later package to the stack's own `CodeBucket`, whose policy lets this function's revisions read it.
* CodeBuild zips the source and calls `s3api put-object`. Versioning is enabled, so the response carries a `VersionId`. Passing that version to `create-web-function-revision` pins the revision to an immutable artifact: a later upload to the same key cannot change what the revision runs.
* The revision records the commit SHA in `APP_COMMIT`, so a response identifies the commit it was built from.
* CodeBuild waits for the revision to reach `Active`, then calls `update-web-function-endpoint` with a single weight of 100 on it. **That call is the release.** An endpoint's [auto-deployment mode](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoints.html) decides whether Lambda routes traffic to new revisions for you, and `AWS::Lambda::WebFunctionEndpoint` has no auto-deployment property, so a CloudFormation-managed endpoint always takes the API default of `Disabled`. `AutoDeploymentMode` on the SAM resource is used at transform time only, to pin the endpoint's weights to the revision the stack creates. A revision the pipeline creates becomes `Active` and serves nothing until the weights move.
* Rolling back is a routing change, not a rebuild: put the weight on an earlier revision. An endpoint routes to one or two revisions with weights totalling 100, which is the room a weighted canary works within.
* `AuthType: IamAuth` means Lambda validates a SigV4 signature before your code sees the request, and callers need `lambda:InvokeWebFunctionEndpoint`. For a caller in the same account an identity-based grant is enough; a resource-based policy on the function is what grants another account or Amazon CloudFront.

Two behaviours to know before building on this:

* **A stack update can take traffic back.** The endpoint's weights are declared as the revision the stack creates. Changing anything that makes CloudFormation create a new revision, such as `FunctionTimeout`, also resets the endpoint to it, and the pipeline's release stops serving traffic until the pipeline runs again.
* **Lambda cleans up old revisions.** 50 revisions per function is an automatic cleanup target, not a hard cap. Lambda deletes the oldest revisions that no endpoint routes to, which can include a rollback target you have removed from all weights. See [Revision limits and automatic cleanup](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-revisions.html).

## Testing

Read the endpoint domain from the stack outputs:

```bash
export ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name $STACK --region $AWS_REGION \
  --query "Stacks[0].Outputs[?OutputKey=='EndpointDomainName'].OutputValue" \
  --output text)
```

An unsigned request is refused by the endpoint, before the application runs:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://$ENDPOINT/
# 403
```

Sign the request with SigV4, using service name `lambda`. The first command exports the credentials of your current AWS CLI profile or session as environment variables. Drop the `x-amz-security-token` header if you use long-term credentials:

```bash
eval "$(aws configure export-credentials --format env)"
curl -s --aws-sigv4 "aws:amz:$AWS_REGION:lambda" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  -H "x-amz-security-token: $AWS_SESSION_TOKEN" \
  -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
  https://$ENDPOINT/
```

The pipeline runs once when the stack is created and releases the commit at the head of the tracked branch, so the response reports that commit:

```json
{
  "commit": "14191474db2fff353b063fe38c4aedc36349f905",
  "environmentStartedAt": "2026-10-16T12:00:00.000Z",
  "uptimeSeconds": 0
}
```

Release a change by pushing to the tracked branch, then check which revision the endpoint serves once the pipeline finishes:

```bash
(cd /path/to/your-repo && git commit --allow-empty -m "Trigger a release" && git push)

aws lambda-web get-web-function-endpoint --function-name $STACK \
  --endpoint-name prod --region $AWS_REGION \
  --query "{mode:autoDeploymentMode,weights:revisionWeights}"
```

Call the endpoint again: `commit` now reports the new commit's SHA, which confirms the build released it. To roll back, move the weight to an earlier revision from `aws lambda-web list-web-function-revisions`:

```bash
aws lambda-web update-web-function-endpoint --function-name $STACK \
  --endpoint-name prod --region $AWS_REGION \
  --revision-weights "revisionId=<< earlier revision >>,weight=100"
```

## Cleanup

The code bucket and the pipeline artifact bucket have versioning enabled. `sam delete` fails with "The bucket you tried to delete is not empty" while either still holds object versions, so empty both first, including delete markers. Their names are in the `CodeBucketName` and `ArtifactBucketName` outputs; the console's **Empty** action or `aws s3api delete-objects` will do it.

1. Delete the stack, once both buckets are empty. This also deletes the `WebFunctionCode` stack that holds the first revision's code:
    ```bash
    sam delete --stack-name $STACK --region $AWS_REGION
    ```
1. Delete the CodeConnections connection if you no longer need it:
    ```bash
    aws codeconnections delete-connection --connection-arn $CONNECTION_ARN --region $AWS_REGION
    ```

----
Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

SPDX-License-Identifier: MIT-0
