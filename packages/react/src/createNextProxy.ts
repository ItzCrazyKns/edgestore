import { type RequestUploadRes } from '@edgestore/server/adapters';
import {
  type AnyRouter,
  type InferBucketPathObject,
  type InferMetadataObject,
} from '@edgestore/server/core';
import { type z } from 'zod';
import EdgeStoreError from './libs/errors/EdgeStoreError';

/**
 * @internal
 * @see https://www.totaltypescript.com/concepts/the-prettify-helper
 */
export type Prettify<TType> = {
  [K in keyof TType]: TType[K];
  // eslint-disable-next-line @typescript-eslint/ban-types
} & {};

export type BucketFunctions<TRouter extends AnyRouter> = {
  [K in keyof TRouter['buckets']]: {
    upload: (
      params: z.infer<TRouter['buckets'][K]['_def']['input']> extends never
        ? {
            file: File;
            onProgressChange?: OnProgressChangeHandler;
            options?: UploadOptions;
          }
        : {
            file: File;
            input: z.infer<TRouter['buckets'][K]['_def']['input']>;
            onProgressChange?: OnProgressChangeHandler;
            options?: UploadOptions;
          },
    ) => Promise<
      TRouter['buckets'][K]['_def']['type'] extends 'IMAGE'
        ? {
            url: string;
            thumbnailUrl: string | null;
            size: number;
            uploadedAt: Date;
            metadata: InferMetadataObject<TRouter['buckets'][K]>;
            path: InferBucketPathObject<TRouter['buckets'][K]>;
            pathOrder: Prettify<
              keyof InferBucketPathObject<TRouter['buckets'][K]>
            >[];
          }
        : {
            url: string;
            size: number;
            uploadedAt: Date;
            metadata: InferMetadataObject<TRouter['buckets'][K]>;
            path: InferBucketPathObject<TRouter['buckets'][K]>;
            pathOrder: Prettify<
              keyof InferBucketPathObject<TRouter['buckets'][K]>
            >[];
          }
    >;
    confirmUpload: (params: { url: string }) => Promise<void>;
    delete: (params: { url: string }) => Promise<void>;
  };
};

type OnProgressChangeHandler = (progress: number) => void;

type UploadOptions = {
  /**
   * e.g. 'my-file-name.jpg'
   *
   * By default, a unique file name will be generated for each upload.
   * If you want to use a custom file name, you can use this option.
   * If you use the same file name for multiple uploads, the previous file will be overwritten.
   * But it might take some time for the CDN cache to be cleared.
   * So maybe you will keep seeing the old file for a while.
   *
   * If you want to replace an existing file immediately leave the `manualFileName` option empty and use the `replaceTargetUrl` option.
   */
  manualFileName?: string;
  /**
   * Use this to replace an existing file.
   * It will automatically delete the existing file when the upload is complete.
   */
  replaceTargetUrl?: string;
  /**
   * If true, the file needs to be confirmed by using the `confirmUpload` function.
   * If the file is not confirmed within 24 hours, it will be deleted.
   *
   * This is useful for pages where the file is uploaded as soon as it is selected,
   * but the user can leave the page without submitting the form.
   *
   * This avoids unnecessary zombie files in the bucket.
   */
  temporary?: boolean;
};

export function createNextProxy<TRouter extends AnyRouter>({
  apiPath,
  uploadingCountRef,
  maxConcurrentUploads = 5,
}: {
  apiPath: string;
  uploadingCountRef: React.MutableRefObject<number>;
  maxConcurrentUploads?: number;
}) {
  return new Proxy<BucketFunctions<TRouter>>({} as BucketFunctions<TRouter>, {
    get(_, prop) {
      const bucketName = prop as keyof TRouter['buckets'];
      const bucketFunctions: BucketFunctions<TRouter>[string] = {
        upload: async (params) => {
          try {
            params.onProgressChange?.(0);
            while (
              uploadingCountRef.current >= maxConcurrentUploads &&
              uploadingCountRef.current > 0
            ) {
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
            uploadingCountRef.current++;
            return await uploadFile(params, {
              bucketName: bucketName as string,
              apiPath,
            });
          } finally {
            uploadingCountRef.current--;
          }
        },
        confirmUpload: async (params: { url: string }) => {
          const { success } = await confirmUpload(params, {
            bucketName: bucketName as string,
            apiPath,
          });
          if (!success) {
            throw new EdgeStoreError('Failed to confirm upload');
          }
        },
        delete: async (params: { url: string }) => {
          const { success } = await deleteFile(params, {
            bucketName: bucketName as string,
            apiPath,
          });
          if (!success) {
            throw new EdgeStoreError('Failed to delete file');
          }
        },
      };
      return bucketFunctions;
    },
  });
}

async function uploadFile(
  {
    file,
    input,
    onProgressChange,
    options,
  }: {
    file: File;
    input?: object;
    onProgressChange?: OnProgressChangeHandler;
    options?: UploadOptions;
  },
  {
    apiPath,
    bucketName,
  }: {
    apiPath: string;
    bucketName: string;
  },
) {
  try {
    onProgressChange?.(0);
    const res = await fetch(`${apiPath}/request-upload`, {
      method: 'POST',
      body: JSON.stringify({
        bucketName,
        input,
        fileInfo: {
          extension: file.name.split('.').pop(),
          type: file.type,
          size: file.size,
          fileName: options?.manualFileName,
          replaceTargetUrl: options?.replaceTargetUrl,
          temporary: options?.temporary,
        },
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const json = (await res.json()) as RequestUploadRes;
    if ('multipart' in json) {
      await multipartUpload({
        bucketName,
        multipartInfo: json.multipart,
        onProgressChange,
        file,
        apiPath,
      });
    } else if ('uploadUrl' in json) {
      // Single part upload
      // Upload the file to the signed URL and get the progress
      await uploadFileInner(file, json.uploadUrl, onProgressChange);
    } else {
      throw new EdgeStoreError('An error occurred');
    }
    return {
      url: getUrl(json.accessUrl, apiPath),
      thumbnailUrl: json.thumbnailUrl
        ? getUrl(json.thumbnailUrl, apiPath)
        : null,
      size: json.size,
      uploadedAt: new Date(json.uploadedAt),
      path: json.path as any,
      pathOrder: json.pathOrder as any,
      metadata: json.metadata as any,
    };
  } catch (e) {
    onProgressChange?.(0);
    throw e;
  }
}

/**
 * Protected files need third-party cookies to work.
 * Since third party cookies doesn't work on localhost,
 * we need to proxy the file through the server.
 */
function getUrl(url: string, apiPath: string) {
  if (process.env.NODE_ENV === 'development' && !url.includes('/_public/')) {
    const proxyUrl = new URL(window.location.origin);
    proxyUrl.pathname = `${apiPath}/proxy-file`;
    proxyUrl.search = new URLSearchParams({
      url,
    }).toString();
    return proxyUrl.toString();
  }
  return url;
}

const uploadFileInner = async (
  file: File | Blob,
  uploadUrl: string,
  onProgressChange?: OnProgressChangeHandler,
) => {
  const promise = new Promise<string | null>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', uploadUrl);
    // This is for Azure provider. Specifies the blob type
    request.setRequestHeader('x-ms-blob-type', 'BlockBlob');
    request.addEventListener('loadstart', () => {
      onProgressChange?.(0);
    });
    request.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        // 2 decimal progress
        const progress = Math.round((e.loaded / e.total) * 10000) / 100;
        onProgressChange?.(progress);
      }
    });
    request.addEventListener('error', () => {
      reject(new Error('Error uploading file'));
    });
    request.addEventListener('abort', () => {
      reject(new Error('File upload aborted'));
    });
    request.addEventListener('loadend', () => {
      // Return the ETag header (needed to complete multipart upload)
      resolve(request.getResponseHeader('ETag'));
    });

    request.send(file);
  });
  return promise;
};

async function multipartUpload(params: {
  bucketName: string;
  multipartInfo: Extract<RequestUploadRes, { multipart: any }>['multipart'];
  onProgressChange: OnProgressChangeHandler | undefined;
  file: File;
  apiPath: string;
}) {
  const { bucketName, multipartInfo, onProgressChange, file, apiPath } = params;
  const { partSize, parts, totalParts, uploadId, key } = multipartInfo;
  const uploadingParts: {
    partNumber: number;
    progress: number;
  }[] = [];
  const uploadPart = async (params: {
    part: typeof parts[number];
    chunk: Blob;
  }) => {
    const { part, chunk } = params;
    const { uploadUrl } = part;
    const eTag = await uploadFileInner(chunk, uploadUrl, (progress) => {
      const uploadingPart = uploadingParts.find(
        (p) => p.partNumber === part.partNumber,
      );
      if (uploadingPart) {
        uploadingPart.progress = progress;
      } else {
        uploadingParts.push({
          partNumber: part.partNumber,
          progress,
        });
      }
      const totalProgress =
        Math.round(
          uploadingParts.reduce((acc, p) => acc + p.progress * 100, 0) /
            totalParts,
        ) / 100;
      onProgressChange?.(totalProgress);
    });
    if (!eTag) {
      throw new EdgeStoreError('Could not get ETag from multipart response');
    }
    return {
      partNumber: part.partNumber,
      eTag,
    };
  };

  // Upload the parts in parallel
  const completedParts = await queuedPromises({
    items: parts.map((part) => ({
      part,
      chunk: file.slice(
        (part.partNumber - 1) * partSize,
        part.partNumber * partSize,
      ),
    })),
    fn: uploadPart,
    maxParallel: 5,
    maxRetries: 10, // retry 10 times per part
  });

  // Complete multipart upload
  const res = await fetch(`${apiPath}/complete-multipart-upload`, {
    method: 'POST',
    body: JSON.stringify({
      bucketName,
      uploadId,
      key,
      parts: completedParts,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new EdgeStoreError('Multi-part upload failed');
  }
}

async function confirmUpload(
  {
    url,
  }: {
    url: string;
  },
  {
    apiPath,
    bucketName,
  }: {
    apiPath: string;
    bucketName: string;
  },
) {
  const res = await fetch(`${apiPath}/confirm-upload`, {
    method: 'POST',
    body: JSON.stringify({
      url,
      bucketName,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new EdgeStoreError('An error occurred');
  }
  return res.json();
}

async function deleteFile(
  {
    url,
  }: {
    url: string;
  },
  {
    apiPath,
    bucketName,
  }: {
    apiPath: string;
    bucketName: string;
  },
) {
  const res = await fetch(`${apiPath}/delete-file`, {
    method: 'POST',
    body: JSON.stringify({
      url,
      bucketName,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new EdgeStoreError('An error occurred');
  }
  return res.json();
}

async function queuedPromises<TType, TRes>({
  items,
  fn,
  maxParallel,
  maxRetries = 0,
}: {
  items: TType[];
  fn: (item: TType) => Promise<TRes>;
  maxParallel: number;
  maxRetries?: number;
}): Promise<TRes[]> {
  const results: TRes[] = new Array(items.length);

  const executeWithRetry = async (
    func: () => Promise<TRes>,
    retries: number,
  ): Promise<TRes> => {
    try {
      return await func();
    } catch (error) {
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return executeWithRetry(func, retries - 1);
      } else {
        throw error;
      }
    }
  };

  const semaphore = {
    count: maxParallel,
    async wait() {
      // If we've reached our maximum concurrency or it's the last item, wait
      while (this.count <= 0)
        await new Promise((resolve) => setTimeout(resolve, 500));
      this.count--;
    },
    signal() {
      this.count++;
    },
  };

  const tasks: Promise<void>[] = items.map((item, i) =>
    (async () => {
      await semaphore.wait();

      try {
        const result = await executeWithRetry(() => fn(item), maxRetries);
        results[i] = result;
      } finally {
        semaphore.signal();
      }
    })(),
  );

  await Promise.all(tasks);
  return results;
}
