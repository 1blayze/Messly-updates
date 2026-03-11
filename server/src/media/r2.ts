import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { GatewayEnv } from "../infra/env";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MANAGED_PREFIXES = [
  "avatars/",
  "banners/",
  "attachments/",
  "videos/",
  "emojis/",
  "guilds/",
  "messages/",
] as const;

export interface SignedPutUrlResult {
  url: string;
  headers: Record<string, string>;
  expiresInSeconds: number;
}

export interface SignedGetUrlResult {
  url: string;
  expiresInSeconds: number;
}

export class MediaR2Client {
  private readonly client: S3Client;

  constructor(private readonly env: GatewayEnv) {
    this.client = new S3Client({
      region: env.r2Region,
      endpoint: env.r2Endpoint,
      forcePathStyle: env.r2ForcePathStyle,
      credentials: {
        accessKeyId: env.r2AccessKeyId,
        secretAccessKey: env.r2SecretAccessKey,
      },
    });
  }

  assertConfigured(): void {
    const required = [
      ["R2_BUCKET", this.env.r2Bucket],
      ["R2_ENDPOINT", this.env.r2Endpoint],
      ["R2_ACCESS_KEY_ID", this.env.r2AccessKeyId],
      ["R2_SECRET_ACCESS_KEY", this.env.r2SecretAccessKey],
    ];

    const missing = required.filter(([, value]) => !String(value ?? "").trim()).map(([key]) => key);
    if (missing.length > 0) {
      throw new Error(`Missing R2 configuration: ${missing.join(", ")}`);
    }
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.env.r2Bucket,
          Key: key,
        }),
      );
      return true;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "name" in error
          ? String((error as { name?: string }).name ?? "")
          : "";
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: string }).message ?? "")
          : "";
      if (
        code === "NotFound" ||
        code === "NoSuchKey" ||
        message.toLowerCase().includes("not found") ||
        message.toLowerCase().includes("nosuchkey")
      ) {
        return false;
      }
      throw error;
    }
  }

  async createSignedPutUrl(
    key: string,
    contentType: string,
    expiresInSeconds: number,
    cacheControl = IMMUTABLE_CACHE_CONTROL,
  ): Promise<SignedPutUrlResult> {
    const command = new PutObjectCommand({
      Bucket: this.env.r2Bucket,
      Key: key,
      ContentType: contentType,
      CacheControl: cacheControl,
    });

    return {
      url: await getSignedUrl(this.client, command, {
        expiresIn: expiresInSeconds,
      }),
      headers: {
        "content-type": contentType,
        "cache-control": cacheControl,
      },
      expiresInSeconds,
    };
  }

  async createSignedGetUrl(key: string, expiresInSeconds: number): Promise<SignedGetUrlResult> {
    const command = new GetObjectCommand({
      Bucket: this.env.r2Bucket,
      Key: key,
    });

    return {
      url: await getSignedUrl(this.client, command, {
        expiresIn: expiresInSeconds,
      }),
      expiresInSeconds,
    };
  }

  async uploadObject(
    key: string,
    body: Buffer,
    contentType: string,
    cacheControl = IMMUTABLE_CACHE_CONTROL,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.env.r2Bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: cacheControl,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.env.r2Bucket,
        Key: key,
      }),
    );
  }

  async listManagedKeys(): Promise<string[]> {
    const results = new Set<string>();

    for (const prefix of MANAGED_PREFIXES) {
      let continuationToken: string | undefined;
      do {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.env.r2Bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          }),
        );

        for (const item of response.Contents ?? []) {
          const key = String(item.Key ?? "").trim();
          if (key) {
            results.add(key);
          }
        }

        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
    }

    return [...results];
  }
}

export function buildCdnUrl(baseUrl: string, fileKey: string): string {
  const normalizedBase = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const normalizedKey = String(fileKey ?? "").trim().replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedKey}`;
}
