export interface HeadResult {
  exists: boolean;
  size?: number;
}

export interface Storage {
  /** Store bytes at key (idempotent). `metadata` becomes x-amz-meta-* on S3. */
  putBytes(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void>;
  head(key: string): Promise<HeadResult>;
  publicUrl(key: string): string;
  delete(key: string): Promise<void>;
}
