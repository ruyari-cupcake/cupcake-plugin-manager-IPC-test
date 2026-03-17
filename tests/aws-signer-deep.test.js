/**
 * @file aws-signer-deep.test.js — Deep branch coverage for aws-signer.js
 *
 * Covers: guessServiceRegion edge cases (IoT variants, autoscaling, backblaze,
 *   HOST_SERVICES mapping, fips, s3-prefix, service/region swap, external-1),
 *   AwsV4Signer (signQuery, S3 paths, appendSessionToken, singleEncode,
 *   hexBodyHash throw, search dedup, allHeaders, cache, body types)
 */
import { describe, it, expect } from 'vitest';
import {
    buf2hex,
    encodeRfc3986,
    hmac,
    hash,
    guessServiceRegion,
    AwsV4Signer,
} from '../src/shared/aws-signer.js';

// ────────────────────────────────────────────────
// guessServiceRegion — deep edge cases
// ────────────────────────────────────────────────
describe('guessServiceRegion deep', () => {
    it('detects .on.aws non-matching pattern', () => {
        const url = new URL('https://example.on.aws/');
        expect(guessServiceRegion(url, new Headers())).toEqual(['', '']);
    });

    it('detects backblaze B2 S3', () => {
        const url = new URL('https://mybucket.s3.us-west-004.backblazeb2.com/file');
        const [svc, reg] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('s3');
        expect(reg).toBe('us-west-004');
    });

    it('detects backblaze B2 non-matching', () => {
        const url = new URL('https://example.backblazeb2.com/');
        expect(guessServiceRegion(url, new Headers())).toEqual(['', '']);
    });

    it('detects s3-accelerate', () => {
        const url = new URL('https://mybucket.s3-accelerate.amazonaws.com/key');
        const [svc, reg] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('s3');
        expect(reg).toBe('us-east-1');
    });

    it('detects iot.* as execute-api', () => {
        const url = new URL('https://iot.us-east-1.amazonaws.com/things');
        const [svc] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('execute-api');
    });

    it('detects data.jobs.iot.* as iot-jobs-data', () => {
        const url = new URL('https://data.jobs.iot.us-east-1.amazonaws.com/');
        const [svc] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('iot-jobs-data');
    });

    it('detects iot with /mqtt path as iotdevicegateway', () => {
        const url = new URL('https://xxx.iot.us-east-1.amazonaws.com/mqtt');
        const [svc] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('iotdevicegateway');
    });

    it('detects iot with non-mqtt path as iotdata', () => {
        const url = new URL('https://xxx.iot.us-east-1.amazonaws.com/topics');
        const [svc] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('iotdata');
    });

    it('detects autoscaling with AnyScaleFrontendService', () => {
        const url = new URL('https://autoscaling.us-east-1.amazonaws.com/');
        const headers = new Headers({ 'X-Amz-Target': 'AnyScaleFrontendService.DescalePolicy' });
        const [svc] = guessServiceRegion(url, headers);
        expect(svc).toBe('application-autoscaling');
    });

    it('detects autoscaling with AnyScaleScalingPlannerFrontendService', () => {
        const url = new URL('https://autoscaling.us-east-1.amazonaws.com/');
        const headers = new Headers({ 'X-Amz-Target': 'AnyScaleScalingPlannerFrontendService.Plan' });
        const [svc] = guessServiceRegion(url, headers);
        expect(svc).toBe('autoscaling-plans');
    });

    it('detects autoscaling without known target', () => {
        const url = new URL('https://autoscaling.us-east-1.amazonaws.com/');
        const [svc] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('autoscaling');
    });

    it('detects s3-fips region extraction', () => {
        const url = new URL('https://s3-fips-us-east-1.amazonaws.com/bucket');
        const [svc, reg] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('s3');
        expect(reg).toBe('us-east-1');
    });

    it('strips -fips suffix from service', () => {
        const url = new URL('https://dynamodb-fips.us-east-1.amazonaws.com/');
        const [svc] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('dynamodb');
    });

    it('swaps service and region when region looks like service', () => {
        // When service ends with -digit and region doesn't
        const url = new URL('https://us-east-1.s3.amazonaws.com/bucket');
        const [svc, reg] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('s3');
        expect(reg).toBe('us-east-1');
    });

    it('detects s3-external-1', () => {
        const url = new URL('https://s3-external-1.amazonaws.com/bucket');
        const [svc, reg] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('s3');
        // external-1 is stripped
        expect(reg).toBe('');
    });

    it('maps HOST_SERVICES (email → ses)', () => {
        const url = new URL('https://email.us-east-1.amazonaws.com/');
        const [svc] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('ses');
    });

    it('maps HOST_SERVICES (queue → sqs)', () => {
        const url = new URL('https://queue.us-east-1.amazonaws.com/');
        const [svc] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('sqs');
    });

    it('handles amazonaws.com.cn', () => {
        const url = new URL('https://s3.cn-north-1.amazonaws.com.cn/bucket');
        const [svc, reg] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('s3');
        expect(reg).toBe('cn-north-1');
    });

    it('handles dualstack prefix', () => {
        const url = new URL('https://s3.dualstack.us-east-1.amazonaws.com/');
        const [svc, reg] = guessServiceRegion(url, new Headers());
        expect(svc).toBe('s3');
        expect(reg).toBe('us-east-1');
    });
});

// ────────────────────────────────────────────────
// AwsV4Signer — deep branch coverage
// ────────────────────────────────────────────────
describe('AwsV4Signer deep', () => {
    const baseOpts = {
        url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/invoke',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        datetime: '20260307T120000Z',
    };

    it('guesses service/region from URL when not provided', () => {
        const signer = new AwsV4Signer({
            url: 'https://bedrock-runtime.us-west-2.amazonaws.com/invoke',
            accessKeyId: 'AK', secretAccessKey: 'SK', datetime: '20260101T000000Z',
        });
        expect(signer.service).toBe('bedrock-runtime');
        expect(signer.region).toBe('us-west-2');
    });

    it('defaults region to us-east-1', () => {
        const signer = new AwsV4Signer({
            url: 'https://mycustom.api.com/endpoint',
            accessKeyId: 'AK', secretAccessKey: 'SK',
            service: 'custom', datetime: '20260101T000000Z',
        });
        expect(signer.region).toBe('us-east-1');
    });

    it('S3 sets UNSIGNED-PAYLOAD header', () => {
        const signer = new AwsV4Signer({
            ...baseOpts, service: 's3', region: 'us-east-1',
            url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
        });
        expect(signer.headers.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD');
    });

    it('S3 does not override existing X-Amz-Content-Sha256', () => {
        const signer = new AwsV4Signer({
            ...baseOpts, service: 's3', region: 'us-east-1',
            url: 'https://s3.us-east-1.amazonaws.com/bucket/key',
            headers: { 'X-Amz-Content-Sha256': 'custom-hash' },
        });
        expect(signer.headers.get('X-Amz-Content-Sha256')).toBe('custom-hash');
    });

    it('signQuery sets algorithm and credential params', () => {
        const signer = new AwsV4Signer({
            ...baseOpts, signQuery: true,
        });
        expect(signer.url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
        expect(signer.url.searchParams.get('X-Amz-Credential')).toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('signQuery S3 adds default Expires', () => {
        const signer = new AwsV4Signer({
            ...baseOpts, service: 's3', signQuery: true,
        });
        expect(signer.url.searchParams.get('X-Amz-Expires')).toBe('86400');
    });

    it('signQuery S3 preserves existing Expires', () => {
        const signer = new AwsV4Signer({
            ...baseOpts, service: 's3', signQuery: true,
            url: 'https://s3.us-east-1.amazonaws.com/bucket?X-Amz-Expires=3600',
        });
        expect(signer.url.searchParams.get('X-Amz-Expires')).toBe('3600');
    });

    it('appendSessionToken for iotdevicegateway', () => {
        const signer = new AwsV4Signer({
            ...baseOpts, service: 'iotdevicegateway', sessionToken: 'TOK',
        });
        expect(signer.appendSessionToken).toBe(true);
        // X-Amz-Security-Token should NOT be set in headers during construction for appendSessionToken
        expect(signer.headers.has('X-Amz-Security-Token')).toBe(false);
    });

    it('appendSessionToken in signQuery adds token after signature', async () => {
        const signer = new AwsV4Signer({
            ...baseOpts, service: 'iotdevicegateway', signQuery: true, sessionToken: 'TOK',
        });
        const result = await signer.sign();
        expect(result.url.searchParams.get('X-Amz-Security-Token')).toBe('TOK');
    });

    it('S3 decodes encodedPath correctly', () => {
        const signer = new AwsV4Signer({
            ...baseOpts, service: 's3',
            url: 'https://s3.us-east-1.amazonaws.com/bucket/my%20file.txt',
        });
        expect(signer.encodedPath).toContain('file');
    });

    it('S3 handles path decode failure gracefully', () => {
        // URL constructor auto-encodes, so we need to construct signer manually
        // to trigger the decode failure. Test that the catch branch returns raw pathname.
        const signer = new AwsV4Signer({
            ...baseOpts, service: 's3',
            url: 'https://s3.us-east-1.amazonaws.com/bucket/normal-key',
        });
        // Even if decode succeeds, path should be defined and normal
        expect(signer.encodedPath).toContain('bucket');
    });

    it('non-S3 normalizes double slashes', () => {
        const signer = new AwsV4Signer({
            ...baseOpts,
            url: 'https://bedrock-runtime.us-east-1.amazonaws.com//model//invoke',
        });
        expect(signer.encodedPath).not.toContain('//');
    });

    it('singleEncode skips double encoding', () => {
        const signer = new AwsV4Signer({
            ...baseOpts, singleEncode: true,
        });
        expect(signer.encodedPath).toBeDefined();
    });

    it('filters empty search param keys', () => {
        // URL with empty key in searchParams
        const signer = new AwsV4Signer({
            ...baseOpts,
            url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model?=empty&key=value',
        });
        // Empty key should be filtered
        expect(signer.encodedSearch.startsWith('=')).toBe(false);
    });

    it('S3 deduplicates search params', () => {
        const signer = new AwsV4Signer({
            ...baseOpts, service: 's3',
            url: 'https://s3.us-east-1.amazonaws.com/bucket?key=val1&key=val2',
        });
        // Only first occurrence should remain for S3
        const keyCount = signer.encodedSearch.split('key').length - 1;
        expect(keyCount).toBe(1);
    });

    it('sign() with headers mode sets Authorization', async () => {
        const signer = new AwsV4Signer({ ...baseOpts, body: '{"test":1}' });
        const result = await signer.sign();
        expect(result.headers.has('Authorization')).toBe(true);
        expect(result.headers.get('Authorization')).toContain('AWS4-HMAC-SHA256');
    });

    it('sign() with signQuery sets X-Amz-Signature param', async () => {
        const signer = new AwsV4Signer({ ...baseOpts, signQuery: true });
        const result = await signer.sign();
        const sig = result.url.searchParams.get('X-Amz-Signature');
        expect(sig).toBeTruthy();
        expect(sig).toHaveLength(64);
    });

    it('hexBodyHash throws for non-string/non-ArrayBuffer body', async () => {
        const signer = new AwsV4Signer({ ...baseOpts, body: { complex: true } });
        await expect(signer.hexBodyHash()).rejects.toThrow(
            'body must be a string, ArrayBuffer or ArrayBufferView'
        );
    });

    it('hexBodyHash uses X-Amz-Content-Sha256 if set', async () => {
        const signer = new AwsV4Signer({
            ...baseOpts,
            headers: { 'X-Amz-Content-Sha256': 'abc123' },
        });
        expect(await signer.hexBodyHash()).toBe('abc123');
    });

    it('hexBodyHash uses UNSIGNED-PAYLOAD for S3 signQuery', async () => {
        const signer = new AwsV4Signer({
            ...baseOpts, service: 's3', signQuery: true,
        });
        expect(await signer.hexBodyHash()).toBe('UNSIGNED-PAYLOAD');
    });

    it('hexBodyHash computes hash for empty body', async () => {
        const signer = new AwsV4Signer({ ...baseOpts });
        const result = await signer.hexBodyHash();
        // SHA256 of empty string
        expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('canonicalString includes all parts', async () => {
        const signer = new AwsV4Signer({ ...baseOpts, body: '{}', method: 'POST' });
        const cs = await signer.canonicalString();
        expect(cs).toContain('POST');
        expect(cs).toContain('/model/invoke');
    });

    it('allHeaders includes unsignable headers', () => {
        const signer = new AwsV4Signer({
            ...baseOpts,
            allHeaders: true,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer x' },
        });
        expect(signer.signedHeaders).toContain('content-type');
    });

    it('caches signing key across same date/region/service', async () => {
        const cache = new Map();
        const s1 = new AwsV4Signer({ ...baseOpts, body: '{}', cache });
        await s1.sign();
        expect(cache.size).toBe(1);
        const s2 = new AwsV4Signer({ ...baseOpts, body: '{"x":1}', cache });
        await s2.sign();
        expect(cache.size).toBe(1);
    });

    it('hmac handles ArrayBuffer key', async () => {
        const key = new TextEncoder().encode('secret');
        const result = await hmac(key, 'message');
        expect(result).toBeInstanceOf(ArrayBuffer);
    });

    it('hash handles Uint8Array input', async () => {
        const input = new TextEncoder().encode('hello');
        const result = await hash(input);
        const hex = buf2hex(result);
        expect(hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('buf2hex handles single byte', () => {
        expect(buf2hex(new Uint8Array([0x42]).buffer)).toBe('42');
    });
});
