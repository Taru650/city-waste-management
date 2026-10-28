import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

export const UPLOAD_URL_TTL_SECONDS = 600;
export const VIEW_URL_TTL_SECONDS = 300;

/**
 * S3-compatible object storage (AWS S3 Mumbai, MinIO on-prem, MeitY cloud).
 * Media bytes never pass through the API on upload: clients PUT to a short-lived
 * pre-signed URL. The bucket must be private; reads also go through signed URLs.
 */
@Injectable()
export class StorageService {
  private readonly client: S3Client;
  /** Signs URLs with the public host, so apps outside the private network can reach storage. */
  private readonly signer: S3Client;
  readonly bucket: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const { s3 } = config;
    const base = {
      region: s3.region,
      forcePathStyle: s3.forcePathStyle,
      credentials: s3.accessKeyId && s3.secretAccessKey ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } : undefined,
    };
    this.client = new S3Client({ ...base, endpoint: s3.endpoint });
    this.signer = new S3Client({ ...base, endpoint: s3.publicEndpoint ?? s3.endpoint });
    this.bucket = s3.bucket;
  }

  /** Content type and length are part of the signature, so the client cannot swap them. */
  presignPut(key: string, contentType: string, contentLength: number): Promise<string> {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: contentLength }),
      { expiresIn: UPLOAD_URL_TTL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) },
    );
  }

  presignGet(key: string): Promise<string> {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: VIEW_URL_TTL_SECONDS });
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async get(key: string, maxBytes: number): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('Object exceeds size limit');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
