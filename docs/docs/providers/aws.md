---
id: aws
title: AWS Provider
sidebar_label: AWS
slug: /providers/aws
---

# AWS Provider

You can also use the Edge Store package with your own AWS S3 bucket. You might want to do that in case you have strict company policies that require you to have all the data in your own AWS account.

By using this provider you will be able to use most of the basic features of Edge Store, but for some of the more advanced features like access control with protected files, you will have to create your own infrastructure and logic from scratch.

## Installation

You need to install some peer dependencies to use this provider.

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

Then you can set the provider in the router.

```ts twoslash {7, 13}
// @noErrors
import { initEdgeStore } from '@edgestore/server';
import {
  createEdgeStoreNextHandler,
  type CreateContextOptions,
} from '@edgestore/server/adapters/next/pages';
import { initEdgeStoreClient } from '@edgestore/server/core';
import { AWSProvider } from '@edgestore/server/providers/aws';
import { z } from 'zod';

// ...

export default createEdgeStoreNextHandler<Context>({
  provider: AWSProvider(),
  router: edgeStoreRouter,
  createContext,
});
```

## Options

```ts
export type AWSProviderOptions = {
  /**
   * Access key for AWS credentials.
   * Can also be set via the `ES_AWS_ACCESS_KEY_ID` environment variable.
   *
   * If unset, the SDK will attempt to use the default credentials provider chain.
   */
  accessKeyId?: string;
  /**
   * Secret access key for AWS credentials.
   * Can also be set via the `ES_AWS_SECRET_ACCESS_KEY` environment variable.
   *
   * If unset, the SDK will attempt to use the default credentials provider chain.
   */
  secretAccessKey?: string;
  /**
   * AWS region to use.
   * Can also be set via the `ES_AWS_REGION` environment variable.
   */
  region?: string;
  /**
   * Name of the S3 bucket to use.
   * Can also be set via the `ES_AWS_BUCKET_NAME` environment variable.
   */
  bucketName?: string;
  /**
   * Base URL to use for accessing files.
   * Only needed if you are using a custom domain or cloudfront.
   *
   * Can also be set via the `EDGE_STORE_BASE_URL` environment variable.
   */
  baseUrl?: string;
  /**
   * Secret to use for encrypting JWT tokens.
   * Can be generated with `openssl rand -base64 32`.
   *
   * Can also be set via the `EDGE_STORE_JWT_SECRET` environment variable.
   */
  jwtSecret?: string;
};
```
