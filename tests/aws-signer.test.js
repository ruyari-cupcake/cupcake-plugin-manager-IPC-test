import { describe, it, expect } from 'vitest';
import {
    buf2hex,
    encodeRfc3986,
    hmac,
    hash,
    guessServiceRegion,
    AwsV4Signer,
} from '../src/shared/aws-signer.js';

describe('buf2hex', () => {
    it('converts ArrayBuffer to hex string', () => {
        const buf = new Uint8Array([0x00, 0xff, 0x0a, 0xbc]).buffer;
        expect(buf2hex(buf)).toBe('00ff0abc');
    });

    it('converts empty buffer', () => {
        expect(buf2hex(new Uint8Array([]).buffer)).toBe('');
    });
});

describe('encodeRfc3986', () => {
    it('encodes RFC3986 special characters', () => {
        expect(encodeRfc3986("test!value'()*")).toBe('test%21value%27%28%29%2A');
    });

    it('passes through normal strings', () => {
        expect(encodeRfc3986('hello')).toBe('hello');
    });
});

describe('hmac', () => {
    it('produces HMAC-SHA256 signature', async () => {
        const result = await hmac('secret', 'message');
        expect(result).toBeInstanceOf(ArrayBuffer);
        const hex = buf2hex(result);
        expect(hex).toHaveLength(64);
    });

    it('is deterministic', async () => {
        const r1 = buf2hex(await hmac('key', 'data'));
        const r2 = buf2hex(await hmac('key', 'data'));
        expect(r1).toBe(r2);
    });

    it('different keys produce different results', async () => {
        const r1 = buf2hex(await hmac('key1', 'data'));
        const r2 = buf2hex(await hmac('key2', 'data'));
        expect(r1).not.toBe(r2);
    });
});

describe('hash', () => {
    it('produces SHA-256 hash', async () => {
        const result = await hash('hello');
        const hex = buf2hex(result);
        expect(hex).toHaveLength(64);
        expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('handles empty string', async () => {
        const result = await hash('');
        const hex = buf2hex(result);
        expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
});

describe('guessServiceRegion', () => {
    it('detects S3 service', () => {
        const url = new URL('https://s3.us-east-1.amazonaws.com/bucket');
        const headers = new Headers();
        expect(guessServiceRegion(url, headers)).toEqual(['s3', 'us-east-1']);
    });

    it('detects Bedrock Runtime', () => {
        const url = new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model');
        const headers = new Headers();
        const [svc, reg] = guessServiceRegion(url, headers);
        expect(svc).toBe('bedrock-runtime');
        expect(reg).toBe('us-east-1');
    });

    it('detects Lambda function URL (.on.aws)', () => {
        const url = new URL('https://abc123.lambda-url.us-west-2.on.aws/');
        const headers = new Headers();
        expect(guessServiceRegion(url, headers)).toEqual(['lambda', 'us-west-2']);
    });

    it('detects R2 Storage (Cloudflare)', () => {
        const url = new URL('https://bucket.r2.cloudflarestorage.com/');
        const headers = new Headers();
        expect(guessServiceRegion(url, headers)).toEqual(['s3', 'auto']);
    });

    it('handles non-AWS hostnames', () => {
        const url = new URL('https://api.openai.com/v1/chat');
        const headers = new Headers();
        expect(guessServiceRegion(url, headers)).toEqual(['', '']);
    });

    it('detects us-gov region', () => {
        const url = new URL('https://s3.us-gov.amazonaws.com/bucket');
        const headers = new Headers();
        const [_service, region] = guessServiceRegion(url, headers);
        expect(region).toBe('us-gov-west-1');
    });
});

describe('AwsV4Signer', () => {
    const baseOpts = {
        url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/invoke',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        service: 'bedrock-runtime',
        region: 'us-east-1',
        datetime: '20260307T120000Z',
    };

    it('requires url', () => {
        expect(() => new AwsV4Signer({ accessKeyId: 'a', secretAccessKey: 'b' })).toThrow('url is a required option');
    });

    it('requires accessKeyId', () => {
        expect(() => new AwsV4Signer({ url: 'https://s3.amazonaws.com', secretAccessKey: 'b' })).toThrow('accessKeyId is a required option');
    });

    it('requires secretAccessKey', () => {
        expect(() => new AwsV4Signer({ url: 'https://s3.amazonaws.com', accessKeyId: 'a' })).toThrow('secretAccessKey is a required option');
    });

    it('constructs with valid options', () => {
        const signer = new AwsV4Signer(baseOpts);
        expect(signer.service).toBe('bedrock-runtime');
        expect(signer.region).toBe('us-east-1');
        expect(signer.method).toBe('GET');
    });

    it('defaults method to POST when body is present', () => {
        const signer = new AwsV4Signer({ ...baseOpts, body: '{}' });
        expect(signer.method).toBe('POST');
    });

    it('produces a valid signature', async () => {
        const signer = new AwsV4Signer({ ...baseOpts, body: '{"test":true}' });
        const signed = await signer.sign();
        expect(signed.headers.has('Authorization')).toBe(true);
        const auth = signed.headers.get('Authorization');
        expect(auth).toContain('AWS4-HMAC-SHA256');
        expect(auth).toContain('Credential=AKIAIOSFODNN7EXAMPLE');
        expect(auth).toContain('SignedHeaders=');
        expect(auth).toContain('Signature=');
    });

    it('caches derived key for same date/region/service', async () => {
        const cache = new Map();
        const signer = new AwsV4Signer({ ...baseOpts, body: '{}', cache });
        await signer.sign();
        expect(cache.size).toBe(1);
        const signer2 = new AwsV4Signer({ ...baseOpts, body: '{"x":1}', cache });
        await signer2.sign();
        expect(cache.size).toBe(1);
    });

    it('handles sessionToken', async () => {
        const signer = new AwsV4Signer({ ...baseOpts, sessionToken: 'SESSION_TOKEN' });
        const signed = await signer.sign();
        expect(signed.headers.get('X-Amz-Security-Token')).toBe('SESSION_TOKEN');
    });

    it('handles signQuery mode', async () => {
        const signer = new AwsV4Signer({ ...baseOpts, signQuery: true });
        const signed = await signer.sign();
        expect(signed.url.searchParams.has('X-Amz-Signature')).toBe(true);
        expect(signed.url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    });
});
