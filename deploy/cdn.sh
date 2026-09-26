#!/usr/bin/env bash
# Create (or update) the S3 bucket and CloudFront CDN that host the audio clips.
# Safe to re-run: every step checks whether its resource already exists.
#
# Result: an mp3 uploaded to s3://dixvoice-clips/audio/<uuid>.mp3 is served at
#         https://<cloudfront-domain>/audio/<uuid>.mp3 (printed at the end).
set -euo pipefail

BUCKET=dixvoice-clips
REGION=eu-west-1
NAME=dixvoice-clips # name of the CloudFront OAC, response headers policy and IAM policy
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
CACHING_OPTIMIZED=658327ea-f89d-4fab-a63d-7e88639e58f6 # AWS managed cache policy

# 1. Private bucket (all public access blocked; only CloudFront reads it).
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# 2. Origin access control: CloudFront signs its requests to the bucket.
OAC_ID=$(aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?Name=='$NAME'].Id | [0]" --output text)
if [ "$OAC_ID" = None ]; then
  OAC_ID=$(aws cloudfront create-origin-access-control --origin-access-control-config \
    "Name=$NAME,Description=Dixvoice clips,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
    --query OriginAccessControl.Id --output text)
fi

# 3. Response headers: open CORS for GET (in case the web app ever fetch()es clips), and strip Last-Modified so
#    upload times never reveal which clips were generated during a game.
RHP_ID=$(aws cloudfront list-response-headers-policies --type custom \
  --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='$NAME'].ResponseHeadersPolicy.Id | [0]" \
  --output text)
if [ "$RHP_ID" = None ]; then
  RHP_ID=$(aws cloudfront create-response-headers-policy --response-headers-policy-config '{
    "Name": "'"$NAME"'",
    "Comment": "Dixvoice clips: CORS for GET, no Last-Modified",
    "CorsConfig": {
      "AccessControlAllowOrigins": {"Quantity": 1, "Items": ["*"]},
      "AccessControlAllowHeaders": {"Quantity": 1, "Items": ["*"]},
      "AccessControlAllowMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]},
      "AccessControlAllowCredentials": false,
      "OriginOverride": true
    },
    "RemoveHeadersConfig": {"Quantity": 1, "Items": [{"Header": "Last-Modified"}]}
  }' --query ResponseHeadersPolicy.Id --output text)
fi

# 4. Distribution.
DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='$NAME'].Id | [0]" --output text)
if [ "$DIST_ID" = None ]; then
  DIST_ID=$(aws cloudfront create-distribution --distribution-config '{
    "CallerReference": "'"$NAME"'",
    "Comment": "'"$NAME"'",
    "Enabled": true,
    "PriceClass": "PriceClass_100",
    "HttpVersion": "http2and3",
    "Origins": {"Quantity": 1, "Items": [{
      "Id": "s3",
      "DomainName": "'"$BUCKET.s3.$REGION.amazonaws.com"'",
      "OriginAccessControlId": "'"$OAC_ID"'",
      "S3OriginConfig": {"OriginAccessIdentity": ""}
    }]},
    "DefaultCacheBehavior": {
      "TargetOriginId": "s3",
      "ViewerProtocolPolicy": "redirect-to-https",
      "CachePolicyId": "'"$CACHING_OPTIMIZED"'",
      "ResponseHeadersPolicyId": "'"$RHP_ID"'",
      "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"],
        "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
      "Compress": false
    }
  }' --query Distribution.Id --output text)
fi
DIST_ARN="arn:aws:cloudfront::$ACCOUNT:distribution/$DIST_ID"
DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --query Distribution.DomainName --output text)

# 5. Bucket policy: only this distribution may read objects.
aws s3api put-bucket-policy --bucket "$BUCKET" --policy '{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "CloudFrontRead",
    "Effect": "Allow",
    "Principal": {"Service": "cloudfront.amazonaws.com"},
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::'"$BUCKET"'/*",
    "Condition": {"StringEquals": {"AWS:SourceArn": "'"$DIST_ARN"'"}}
  }]
}'

# 6. IAM policy for the audio service to upload clips (attach it to the service's role or user).
POLICY_ARN="arn:aws:iam::$ACCOUNT:policy/$NAME-write"
if ! aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  aws iam create-policy --policy-name "$NAME-write" --description "Upload Dixvoice audio clips" --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {"Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::'"$BUCKET"'/audio/*"},
      {"Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::'"$BUCKET"'"}
    ]
  }' >/dev/null
fi

echo "bucket:        s3://$BUCKET (region $REGION)"
echo "distribution:  $DIST_ID"
echo "clip URLs:     https://$DOMAIN/audio/<uuid>.mp3"
echo "upload policy: $POLICY_ARN"
