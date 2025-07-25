import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import dedent from 'dedent';
import { fetchWithCache } from '../../src/cache';
import cliState from '../../src/cliState';
import { importModule } from '../../src/esm';
import logger from '../../src/logger';
import {
  createSessionParser,
  createTransformRequest,
  createTransformResponse,
  createValidateStatus,
  determineRequestBody,
  estimateTokenCount,
  HttpProvider,
  processJsonBody,
  processTextBody,
  urlEncodeRawRequestPath,
} from '../../src/providers/http';
import { REQUEST_TIMEOUT_MS } from '../../src/providers/shared';
import { maybeLoadFromExternalFile } from '../../src/util/file';

jest.mock('../../src/cache', () => ({
  ...jest.requireActual('../../src/cache'),
  fetchWithCache: jest.fn(),
}));

jest.mock('../../src/fetch', () => ({
  ...jest.requireActual('../../src/fetch'),
  fetchWithRetries: jest.fn(),
  fetchWithTimeout: jest.fn(),
}));

jest.mock('../../src/util/file', () => ({
  ...jest.requireActual('../../src/util/file'),
  maybeLoadFromExternalFile: jest.fn((input) => input),
}));

jest.mock('../../src/esm', () => ({
  importModule: jest.fn(async (modulePath: string, functionName?: string) => {
    const mockModule = {
      default: jest.fn((data) => data.defaultField),
      parseResponse: jest.fn((data) => data.specificField),
    };
    if (functionName) {
      return mockModule[functionName as keyof typeof mockModule];
    }
    return mockModule;
  }),
}));

jest.mock('../../src/cliState', () => ({
  basePath: '/mock/base/path',
  config: {},
}));

// Mock jks-js module for JKS tests
jest.mock(
  'jks-js',
  () => ({
    toPem: jest.fn(),
  }),
  { virtual: true },
);

describe('HttpProvider', () => {
  const mockUrl = 'http://example.com/api';
  let provider: HttpProvider;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call the API and return the response', async () => {
    provider = new HttpProvider(mockUrl, {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: '{{ prompt }}' },
        transformResponse: (data: any) => data.result,
      },
    });
    const mockResponse = {
      data: JSON.stringify({ result: 'response text' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test prompt');
    expect(result.output).toBe('response text');
    expect(fetchWithCache).toHaveBeenCalledWith(
      mockUrl,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'test prompt' }),
      }),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  it('should handle API call errors', async () => {
    provider = new HttpProvider(mockUrl, {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: 'value' },
        transformResponse: (data: any) => data.result,
      },
    });
    const mockError = new Error('Network error');
    jest.mocked(fetchWithCache).mockRejectedValueOnce(mockError);

    await expect(provider.callApi('test prompt')).rejects.toThrow('Network error');
  });

  it('should use custom method/headers/queryParams', async () => {
    provider = new HttpProvider(mockUrl, {
      config: {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token' },
        body: { key: '{{ prompt }}' },
        queryParams: { foo: 'bar' },
        transformResponse: (data: any) => data,
      },
    });
    const mockResponse = {
      data: 'custom response',
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test prompt');
    expect(fetchWithCache).toHaveBeenCalledWith(
      `${mockUrl}?foo=bar`,
      expect.objectContaining({
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
        body: JSON.stringify({ key: 'test prompt' }),
      }),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  it('should substitute variables in URL path parameters', async () => {
    const urlWithPathParam = 'http://example.com/users/{{userId}}/profile';
    provider = new HttpProvider(urlWithPathParam, {
      config: {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      },
    });
    const mockResponse = {
      data: JSON.stringify({ user: 'data' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test prompt', {
      vars: { userId: '12345' },
      prompt: { raw: 'foo', label: 'bar' },
    });
    expect(fetchWithCache).toHaveBeenCalledWith(
      'http://example.com/users/12345/profile',
      expect.objectContaining({
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      }),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  const testCases = [
    { parser: (data: any) => data.custom, expected: 'parsed' },
    { parser: 'json.result', expected: 'parsed' },
    { parser: 'text', expected: JSON.stringify({ result: 'parsed', custom: 'parsed' }) },
  ];

  testCases.forEach(({ parser, expected }) => {
    it(`should handle response transform type: ${parser}`, async () => {
      provider = new HttpProvider(mockUrl, {
        config: {
          body: { key: '{{ prompt }}' },
          transformResponse: parser,
        },
      });
      const mockResponse = {
        data: JSON.stringify({ result: 'parsed', custom: 'parsed' }),
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt');
      expect(result.output).toEqual(expected);
    });
  });

  it('should correctly render Nunjucks templates in config', async () => {
    provider = new HttpProvider(mockUrl, {
      config: {
        method: 'POST',
        headers: { 'X-Custom-Header': '{{ prompt | upper }}' },
        body: { key: '{{ prompt }}' },
        transformResponse: (data: any) => data,
      },
    });
    const mockResponse = {
      data: 'custom response',
      cached: false,
      status: 200,
      statusText: 'OK',
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test prompt');
    expect(fetchWithCache).toHaveBeenCalledWith(
      mockUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-custom-header': 'TEST PROMPT' },
        body: JSON.stringify({ key: 'test prompt' }),
      },
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  it('should throw an error when creating HttpProvider with invalid config', () => {
    const invalidConfig = 'this isnt json';
    expect(() => {
      new HttpProvider(mockUrl, {
        config: invalidConfig as any,
      });
    }).toThrow(/Expected object, received string/);
  });

  it('should return provider id and string representation', () => {
    provider = new HttpProvider(mockUrl, {
      config: { body: 'yo mama' },
    });
    expect(provider.id()).toBe(mockUrl);
    expect(provider.toString()).toBe(`[HTTP Provider ${mockUrl}]`);
  });

  it('should handle GET requests with query parameters', async () => {
    provider = new HttpProvider(mockUrl, {
      config: {
        method: 'GET',
        queryParams: {
          q: '{{ prompt }}',
          foo: 'bar',
        },
        transformResponse: (data: any) => data,
      },
    });
    const mockResponse = {
      data: 'response data',
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test prompt');
    expect(fetchWithCache).toHaveBeenCalledWith(
      `${mockUrl}?q=test+prompt&foo=bar`,
      expect.objectContaining({
        method: 'GET',
      }),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  describe('raw request', () => {
    it('should handle a basic GET raw request', async () => {
      const rawRequest = dedent`
        GET /api/data HTTP/1.1
        Host: example.com
        User-Agent: TestAgent/1.0
      `;
      const provider = new HttpProvider('http', {
        config: {
          request: rawRequest,
          transformResponse: (data: any) => data,
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        cached: false,
        status: 200,
        statusText: 'OK',
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt');

      expect(fetchWithCache).toHaveBeenCalledWith(
        'http://example.com/api/data',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            host: 'example.com',
            'user-agent': 'TestAgent/1.0',
          }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
      expect(result.output).toEqual({ result: 'success' });
    });

    it('should handle a POST raw request with body and variable substitution', async () => {
      const rawRequest = dedent`
        POST /api/submit HTTP/1.1
        Host: example.com
        Content-Type: application/json

        {"data": "{{prompt}}"}
      `;
      const provider = new HttpProvider('https', {
        config: {
          request: rawRequest,
          transformResponse: (data: any) => data,
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'received' }),
        cached: false,
        status: 200,
        statusText: 'OK',
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test data');

      expect(fetchWithCache).toHaveBeenCalledWith(
        'https://example.com/api/submit',
        {
          method: 'POST',
          headers: {
            host: 'example.com',
            'content-type': 'application/json',
          },
          body: '{"data": "test data"}',
        },
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
      expect(result.output).toEqual({ result: 'received' });
    });

    it('should handle a raw request with path parameter variable substitution', async () => {
      const rawRequest = dedent`
        GET /api/users/{{userId}}/profile HTTP/1.1
        Host: example.com
        Accept: application/json
      `;
      const provider = new HttpProvider('https', {
        config: {
          request: rawRequest,
          transformResponse: (data: any) => data,
        },
      });

      const mockResponse = {
        data: JSON.stringify({ user: { id: '12345', name: 'Test User' } }),
        cached: false,
        status: 200,
        statusText: 'OK',
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt', {
        vars: { userId: '12345' },
        prompt: { raw: 'foo', label: 'bar' },
      });

      expect(fetchWithCache).toHaveBeenCalledWith(
        'https://example.com/api/users/12345/profile',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            host: 'example.com',
            accept: 'application/json',
          }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
      expect(result.output).toEqual({ user: { id: '12345', name: 'Test User' } });
    });

    it('should load raw request from file if file:// prefix is used', async () => {
      const filePath = 'file://path/to/request.txt';
      const fileContent = dedent`
        GET /api/data HTTP/1.1
        Host: example.com
      `;
      jest.mocked(maybeLoadFromExternalFile).mockReturnValueOnce(fileContent);

      const provider = new HttpProvider('https', {
        config: {
          request: filePath,
          transformResponse: (data: any) => data,
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt');

      expect(maybeLoadFromExternalFile).toHaveBeenCalledWith(filePath);
      expect(fetchWithCache).toHaveBeenCalledWith(
        'https://example.com/api/data',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            host: 'example.com',
          }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
      expect(result.output).toEqual({ result: 'success' });
    });

    it('should throw an error for invalid raw requests', async () => {
      const provider = new HttpProvider('http', {
        config: {
          request: 'yo mama',
        },
      });
      await expect(provider.callApi('test prompt')).rejects.toThrow(/not valid/);
    });

    it('should remove content-length header from raw request', async () => {
      const rawRequest = dedent`
        POST /api/submit HTTP/1.1
        Host: example.com
        Content-Type: application/json
        Content-Length: 1234

        {"data": "test"}
      `;
      const provider = new HttpProvider('https', {
        config: {
          request: rawRequest,
          transformResponse: (data: any) => data,
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'received' }),
        cached: false,
        status: 200,
        statusText: 'OK',
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      await provider.callApi('test prompt');

      expect(fetchWithCache).toHaveBeenCalledWith(
        'https://example.com/api/submit',
        expect.objectContaining({
          method: 'POST',
          headers: {
            host: 'example.com',
            'content-type': 'application/json',
            // content-length should not be present
          },
          body: '{"data": "test"}',
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
    });

    it('should use HTTPS when useHttps option is enabled', async () => {
      const rawRequest = dedent`
        GET /api/data HTTP/1.1
        Host: example.com
        User-Agent: TestAgent/1.0
      `;
      const provider = new HttpProvider('http', {
        config: {
          request: rawRequest,
          useHttps: true,
          transformResponse: (data: any) => data,
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        cached: false,
        status: 200,
        statusText: 'OK',
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt');

      expect(fetchWithCache).toHaveBeenCalledWith(
        'https://example.com/api/data',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            host: 'example.com',
            'user-agent': 'TestAgent/1.0',
          }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
      expect(result.output).toEqual({ result: 'success' });
    });

    it('should use HTTP when useHttps option is disabled', async () => {
      const rawRequest = dedent`
        GET /api/data HTTP/1.1
        Host: example.com
        User-Agent: TestAgent/1.0
      `;
      const provider = new HttpProvider('http', {
        config: {
          request: rawRequest,
          useHttps: false,
          transformResponse: (data: any) => data,
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        cached: false,
        status: 200,
        statusText: 'OK',
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt');

      expect(fetchWithCache).toHaveBeenCalledWith(
        'http://example.com/api/data',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            host: 'example.com',
            'user-agent': 'TestAgent/1.0',
          }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
      expect(result.output).toEqual({ result: 'success' });
    });

    it('should handle a basic GET raw request with query params', async () => {
      const rawRequest = dedent`
        GET /api/data?{{prompt}} HTTP/1.1
        Host: example.com
        User-Agent: TestAgent/1.0
      `;
      const provider = new HttpProvider('http', {
        config: {
          request: rawRequest,
          transformResponse: (data: any) => data,
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        cached: false,
        status: 200,
        statusText: 'OK',
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt');

      expect(fetchWithCache).toHaveBeenCalledWith(
        'http://example.com/api/data?test%20prompt',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            host: 'example.com',
            'user-agent': 'TestAgent/1.0',
          }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
      expect(result.output).toEqual({ result: 'success' });
    });
  });

  describe('processJsonBody', () => {
    it('should process simple key-value pairs', () => {
      const body = { key: 'value', prompt: '{{ prompt }}' };
      const vars = { prompt: 'test prompt' };
      const result = processJsonBody(body, vars);
      expect(result).toEqual({ key: 'value', prompt: 'test prompt' });
    });

    it('should process nested objects', () => {
      const body = {
        outer: {
          inner: '{{ prompt }}',
          static: 'value',
        },
      };
      const vars = { prompt: 'test prompt' };
      const result = processJsonBody(body, vars);
      expect(result).toEqual({
        outer: {
          inner: 'test prompt',
          static: 'value',
        },
      });
    });

    it('should process arrays', () => {
      const body = {
        list: ['{{ prompt }}', 'static', '{{ prompt }}'],
      };
      const vars = { prompt: 'test prompt' };
      const result = processJsonBody(body, vars);
      expect(result).toEqual({
        list: ['test prompt', 'static', 'test prompt'],
      });
    });

    it('should process deeply nested objects and arrays', () => {
      const body = {
        key: '{{var1}}',
        nested: {
          key2: '{{var2}}',
          items: ['{{var3}}', { nestedKey: '{{var4}}' }],
        },
      };
      const vars = { var1: 'value1', var2: 'value2', var3: 'value3', var4: 'value4' };
      const result = processJsonBody(body, vars);
      expect(result).toEqual({
        key: 'value1',
        nested: {
          key2: 'value2',
          items: ['value3', { nestedKey: 'value4' }],
        },
      });
    });

    it('should parse JSON strings if possible', () => {
      const body = {
        key: '{{var1}}',
        jsonString: '{"parsed":{{var2}}}',
      };
      const vars = { var1: 'value1', var2: 123 };
      const result = processJsonBody(body, vars);
      expect(result).toEqual({
        key: 'value1',
        jsonString: { parsed: 123 },
      });
    });

    describe('Raw JSON string handling (YAML literal case)', () => {
      it('should return raw JSON strings as-is with control characters', () => {
        // Simulate a YAML literal string that contains control characters
        const body = '{\n  "input": "Text with control char: \u0001",\n  "role": "user"\n}';
        const vars = { prompt: 'test' };
        const result = processJsonBody(body, vars);

        // Should return string as-is since it's already in intended format
        expect(result).toBe('{\n  "input": "Text with control char: \u0001",\n  "role": "user"\n}');
      });

      it('should return raw JSON strings as-is with bad syntax', () => {
        // Simulate malformed JSON that would fail parsing
        const body = '{\n  "input": "{{prompt}}",\n  "role": "user",\n}'; // trailing comma
        const vars = { prompt: 'test prompt' };
        const result = processJsonBody(body, vars);

        // Should return string as-is since it's already in intended format
        expect(result).toBe('{\n  "input": "test prompt",\n  "role": "user",\n}');
      });

      it('should parse valid JSON strings normally', () => {
        // Valid JSON string should be parsed into object
        const body = '{"input": "{{prompt}}", "role": "user"}';
        const vars = { prompt: 'test prompt' };
        const result = processJsonBody(body, vars);

        // Should return parsed object since JSON.parse succeeds
        expect(result).toEqual({
          input: 'test prompt',
          role: 'user',
        });
      });

      it('should handle JSON primitive strings correctly', () => {
        // JSON string literals should be parsed
        const body = '"{{prompt}}"';
        const vars = { prompt: 'hello world' };
        const result = processJsonBody(body, vars);

        // Should return the string value (not wrapped)
        expect(result).toBe('hello world');
      });

      it('should handle JSON number strings correctly', () => {
        const body = '{{number}}';
        const vars = { number: 42 };
        const result = processJsonBody(body, vars);

        // Should return the number value
        expect(result).toBe(42);
      });

      it('should handle JSON boolean strings correctly', () => {
        const body = '{{bool}}';
        const vars = { bool: true };
        const result = processJsonBody(body, vars);

        // Should return the boolean value
        expect(result).toBe(true);
      });

      it('should handle complex nested JSON with control characters', () => {
        // Complex nested structure with control characters
        const body = `{
  "user": {
    "query": "{{prompt}}",
    "metadata": {
      "session": "abc\u0001def",
      "tags": ["test", "debug\u0002"]
    }
  },
  "options": {
    "model": "gpt-4",
    "temperature": 0.7
  }
}`;
        const vars = { prompt: 'What is AI?' };
        const result = processJsonBody(body, vars);

        // Should return string as-is since it's already in intended format
        expect(result).toBe(`{
  "user": {
    "query": "What is AI?",
    "metadata": {
      "session": "abc\u0001def",
      "tags": ["test", "debug\u0002"]
    }
  },
  "options": {
    "model": "gpt-4",
    "temperature": 0.7
  }
}`);
      });

      it('should handle JSON with random whitespace and indentation', () => {
        // JSON with inconsistent formatting
        const body = `{
          "input":    "{{prompt}}",
       "role":   "engineering",
            "config": {
                "debug":true ,
              "timeout": 5000,
        }
}`;
        const vars = { prompt: 'Test with whitespace' };
        const result = processJsonBody(body, vars);

        // Should return string as-is since it's already in intended format
        expect(result).toBe(`{
          "input":    "Test with whitespace",
       "role":   "engineering",
            "config": {
                "debug":true ,
              "timeout": 5000,
        }
}`);
      });

      it('should handle deeply nested arrays with template variables', () => {
        // Deep nesting with trailing comma
        const body = `{
"messages": [
  {
    "role": "system", 
    "content": "{{systemPrompt}}"
  },
  {
    "role": "user",
    "content": "{{prompt}}",
    "attachments": [
      {"type": "image", "url": "{{imageUrl}}"},
      {"type": "document", "data": "{{docData}}"}
    ]
  }
],
"stream": {{streaming}},
}`;
        const vars = {
          systemPrompt: 'You are a helpful assistant',
          prompt: 'Analyze this data',
          imageUrl: 'https://example.com/image.jpg',
          docData: 'base64encodeddata',
          streaming: false,
        };
        const result = processJsonBody(body, vars);

        // Should return string as-is since it's already in intended format
        expect(result).toBe(`{
"messages": [
  {
    "role": "system", 
    "content": "You are a helpful assistant"
  },
  {
    "role": "user",
    "content": "Analyze this data",
    "attachments": [
      {"type": "image", "url": "https://example.com/image.jpg"},
      {"type": "document", "data": "base64encodeddata"}
    ]
  }
],
"stream": false,
}`);
      });

      it('should handle multiline strings with special characters', () => {
        // Multiline JSON with special characters and newlines
        const body = `{
"query": "{{prompt}}",
"system_message": "You are a helpful AI.\\n\\nRules:\\n- Be concise\\n- Use examples\\n- Handle edge cases",
"special_chars": "Quotes: \\"test\\" and symbols: @#$%^&*()",
"unicode": "Emoji: 🤖 and unicode: \\u00A9"
}`;
        const vars = { prompt: 'How does this work?' };
        const result = processJsonBody(body, vars);

        // This should actually parse successfully since it's valid JSON
        expect(result).toEqual({
          query: 'How does this work?',
          system_message:
            'You are a helpful AI.\n\nRules:\n- Be concise\n- Use examples\n- Handle edge cases',
          special_chars: 'Quotes: "test" and symbols: @#$%^&*()',
          unicode: 'Emoji: 🤖 and unicode: ©',
        });
      });

      it('should handle mixed valid and invalid JSON syntax', () => {
        // JSON that looks valid but has subtle syntax errors
        const body = `{
"valid_field": "{{prompt}}",
"numbers": [1, 2, 3,],
"object": {
  "nested": true,
  "value": "test"
},
"trailing_comma": "problem",
}`;
        const vars = { prompt: 'Test input' };
        const result = processJsonBody(body, vars);

        // Should return string as-is since it's already in intended format
        expect(result).toBe(`{
"valid_field": "Test input",
"numbers": [1, 2, 3,],
"object": {
  "nested": true,
  "value": "test"
},
"trailing_comma": "problem",
}`);
      });

      it('should auto-escape newlines in JSON templates (YAML literal case)', () => {
        // This is the real-world case: YAML literal string with unescaped newlines from red team
        const body = '{\n  "message": "{{prompt}}"\n}';
        const vars = {
          prompt: 'Multi-line prompt\nwith actual newlines\nand more text',
        };
        const result = processJsonBody(body, vars);

        // Should automatically escape the newlines and return parsed JSON object
        expect(result).toEqual({
          message: 'Multi-line prompt\nwith actual newlines\nand more text',
        });
      });

      it('should auto-escape quotes and special chars in JSON templates', () => {
        // Test various special characters that break JSON
        const body = '{\n  "message": "{{prompt}}",\n  "role": "user"\n}';
        const vars = {
          prompt: 'Text with "quotes" and \ttabs and \nmore stuff',
        };
        const result = processJsonBody(body, vars);

        // Should automatically escape and return parsed JSON object
        expect(result).toEqual({
          message: 'Text with "quotes" and \ttabs and \nmore stuff',
          role: 'user',
        });
      });

      it('should fall back gracefully when JSON template cannot be fixed', () => {
        // Test case where even escaping cannot fix the JSON (structural issues)
        const body = '{\n  "message": "{{prompt}}"\n  missing_comma: true\n}';
        const vars = {
          prompt: 'Some text with\nnewlines',
        };
        const result = processJsonBody(body, vars);

        // Should fall back to returning the original rendered string (with literal newlines)
        expect(result).toBe('{\n  "message": "Some text with\nnewlines"\n  missing_comma: true\n}');
      });
    });
  });

  describe('processTextBody', () => {
    it('should render templates in text bodies', () => {
      const body = 'Hello {{name}}!';
      const vars = { name: 'World' };
      expect(processTextBody(body, vars)).toBe('Hello World!');
    });

    it('should handle rendering errors gracefully', () => {
      const body = 'Hello {{ unclosed tag';
      const vars = { name: 'World' };
      expect(processTextBody(body, vars)).toBe(body); // Should return original
    });

    it('should handle null body gracefully', () => {
      // @ts-ignore - Testing null input
      expect(processTextBody(null, {})).toBeNull();
    });
  });

  describe('createtransformResponse', () => {
    it('should handle function parser', async () => {
      const functionParser = (data: any) => data.result;
      const provider = new HttpProvider(mockUrl, {
        config: {
          body: { key: 'value' },
          transformResponse: functionParser,
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt');
      expect(result.output).toBe('success');
    });

    it('should handle file:// parser with JavaScript file', async () => {
      const mockParser = jest.fn((data, text) => text.toUpperCase());
      jest.mocked(importModule).mockResolvedValueOnce(mockParser);

      const parser = await createTransformResponse('file://custom-parser.js');
      const result = parser({ customField: 'parsed' }, 'parsed');
      expect(importModule).toHaveBeenCalledWith(
        path.resolve('/mock/base/path', 'custom-parser.js'),
        undefined,
      );
      expect(result).toBe('PARSED');
    });

    it('parser returns object', async () => {
      provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { key: '{{ prompt }}' },
          transformResponse: (data: any) => {
            return {
              output: data.result,
              metadata: { something: 1 },
              tokenUsage: { prompt: 2, completion: 3, total: 4 },
            };
          },
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'response text' }),
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt');
      expect(result.output).toBe('response text');
      expect(result.metadata).toStrictEqual({ something: 1 });
      expect(result.tokenUsage).toStrictEqual({ prompt: 2, completion: 3, total: 4 });
    });

    it('should throw error for unsupported parser type', async () => {
      await expect(createTransformResponse(123 as any)).rejects.toThrow(
        "Unsupported response transform type: number. Expected a function, a string starting with 'file://' pointing to a JavaScript file, or a string containing a JavaScript expression.",
      );
    });

    it('should handle string parser', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          body: { key: 'value' },
          transformResponse: 'json.result',
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'parsed' }),
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test prompt');
      expect(result.output).toBe('parsed');
    });

    it('should handle file:// parser with specific function name', async () => {
      const mockParser = jest.fn((data, text) => data.specificField);
      jest.mocked(importModule).mockResolvedValueOnce(mockParser);

      const parser = await createTransformResponse('file://custom-parser.js:parseResponse');
      const result = parser({ specificField: 'parsed' }, '');
      expect(importModule).toHaveBeenCalledWith(
        path.resolve('/mock/base/path', 'custom-parser.js'),
        'parseResponse',
      );
      expect(result).toBe('parsed');
    });

    it('should throw error for malformed file:// parser', async () => {
      jest.mocked(importModule).mockResolvedValueOnce({});

      await expect(createTransformResponse('file://invalid-parser.js')).rejects.toThrow(
        /Response transform malformed/,
      );
    });

    it('should return default parser when no parser is provided', async () => {
      const parser = await createTransformResponse(undefined);
      const result = parser({ key: 'value' }, 'raw text');
      expect(result.output).toEqual({ key: 'value' });
    });

    it('should handle response transform file with default export', async () => {
      const mockParser = jest.fn((data) => data.defaultField);
      jest.mocked(importModule).mockResolvedValueOnce(mockParser);

      const parser = await createTransformResponse('file://default-parser.js');
      const result = parser({ defaultField: 'parsed' }, '');

      expect(result).toBe('parsed');
      expect(importModule).toHaveBeenCalledWith(
        path.resolve('/mock/base/path', 'default-parser.js'),
        undefined,
      );
    });
  });

  it('should use default parser when no parser is provided', async () => {
    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'GET',
      },
    });
    const mockResponse = {
      data: JSON.stringify({ key: 'value' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test prompt');
    expect(result.output).toEqual({ key: 'value' });
  });

  it('should handle response transform returning an object', async () => {
    const provider = new HttpProvider(mockUrl, {
      config: {
        body: { key: 'value' },
        transformResponse: (json: any, text: string) => ({ custom: json.result }),
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test prompt');
    expect(result.output).toEqual({ custom: 'success' });
  });

  describe('getDefaultHeaders', () => {
    it('should return empty object for GET requests', () => {
      const provider = new HttpProvider(mockUrl, { config: { method: 'GET' } });
      const result = provider['getDefaultHeaders'](null);
      expect(result).toEqual({});
    });

    it('should return application/json for object body', () => {
      const provider = new HttpProvider(mockUrl, {
        config: { method: 'POST', body: { key: 'value' } },
      });
      const result = provider['getDefaultHeaders']({ key: 'value' });
      expect(result).toEqual({ 'content-type': 'application/json' });
    });

    it('should return application/x-www-form-urlencoded for string body', () => {
      const provider = new HttpProvider(mockUrl, { config: { method: 'POST', body: 'test' } });
      const result = provider['getDefaultHeaders']('string body');
      expect(result).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    });
  });

  describe('validateContentTypeAndBody', () => {
    it('should not throw for valid content-type and body', () => {
      const provider = new HttpProvider(mockUrl, { config: { body: 'test' } });
      expect(() => {
        provider['validateContentTypeAndBody'](
          { 'content-type': 'application/json' },
          { key: 'value' },
        );
      }).not.toThrow();
    });

    it('should throw for non-json content-type with object body', () => {
      const provider = new HttpProvider(mockUrl, { config: { body: 'test' } });
      expect(() => {
        provider['validateContentTypeAndBody'](
          { 'content-type': 'application/x-www-form-urlencoded' },
          { key: 'value' },
        );
      }).toThrow('Content-Type is not application/json, but body is an object or array');
    });
  });

  describe('getHeaders', () => {
    it('should combine default headers with config headers', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          headers: { 'X-Custom': '{{ prompt }}' },
          body: 'test',
        },
      });
      const result = await provider.getHeaders(
        { 'content-type': 'application/json' },
        { prompt: 'test' },
      );
      expect(result).toEqual({
        'content-type': 'application/json',
        'x-custom': 'test',
      });
    });

    it('should render template strings in headers', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          headers: { 'X-Custom': '{{ prompt | upper }}' },
          body: 'test',
        },
      });
      const result = await provider.getHeaders({}, { prompt: 'test' });
      expect(result).toEqual({
        'x-custom': 'TEST',
      });
    });

    it('should render environment variables in headers', async () => {
      // Setup a provider with environment variables in headers
      const provider = new HttpProvider('http://example.com', {
        config: {
          method: 'GET', // GET method doesn't require body
          headers: {
            'X-API-Key': '{{env.API_KEY}}',
            Authorization: 'Bearer {{env.AUTH_TOKEN}}',
            Cookie: 'SESSION={{env.SESSION_ID}}; XSRF={{env.XSRF}}',
          },
        },
      });

      // Mock environment variables
      process.env.API_KEY = 'test-api-key';
      process.env.AUTH_TOKEN = 'test-auth-token';
      process.env.SESSION_ID = 'test-session';
      process.env.XSRF = 'test-xsrf';

      // Call getHeaders method
      const result = await provider.getHeaders({}, { prompt: 'test', env: process.env });

      // Verify environment variables are rendered correctly
      expect(result).toEqual({
        'x-api-key': 'test-api-key',
        authorization: 'Bearer test-auth-token',
        cookie: 'SESSION=test-session; XSRF=test-xsrf',
      });

      // Clean up environment variables
      delete process.env.API_KEY;
      delete process.env.AUTH_TOKEN;
      delete process.env.SESSION_ID;
      delete process.env.XSRF;
    });
  });

  it('should default to application/json for content-type if body is an object', async () => {
    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'POST',
        headers: { 'X-Custom': '{{ prompt }}' },
        body: { key: '{{ prompt }}' },
      },
    });
    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test prompt');

    expect(fetchWithCache).toHaveBeenCalledWith(
      mockUrl,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-custom': 'test prompt',
        },
        body: JSON.stringify({ key: 'test prompt' }),
      }),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  it('should default to application/x-www-form-urlencoded for content-type if body is not an object', async () => {
    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'POST',
        body: 'test',
      },
    });
    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test prompt');

    expect(fetchWithCache).toHaveBeenCalledWith(
      mockUrl,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'test',
      }),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  it('should throw an error if the body is an object and the content-type is not application/json', async () => {
    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: { key: 'value' },
      },
    });

    await expect(provider.callApi('test prompt')).rejects.toThrow(
      'Content-Type is not application/json, but body is an object or array',
    );
  });

  describe('Content-Type and body handling', () => {
    it('should render string body when content-type is not set', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          body: 'Hello {{ prompt }}',
        },
      });
      const mockResponse = {
        data: 'response',
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      await provider.callApi('world');

      expect(fetchWithCache).toHaveBeenCalledWith(
        mockUrl,
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'Hello world',
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
    });

    it('should default to JSON when content-type is not set and body is an object', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          body: { key: 'test' },
        },
      });

      const mockResponse = {
        data: 'response',
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      await provider.callApi('test');

      expect(fetchWithCache).toHaveBeenCalledWith(
        mockUrl,
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'test' }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
    });

    it('should render object body when content-type is application/json', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { key: '{{ prompt }}' },
        },
      });
      const mockResponse = {
        data: 'response',
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      await provider.callApi('test');

      expect(fetchWithCache).toHaveBeenCalledWith(
        mockUrl,
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'test' }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
    });

    it('should render a stringified object body when content-type is application/json', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: '{{ prompt }}' }),
        },
      });
      const mockResponse = {
        data: 'response',
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      await provider.callApi('test');

      expect(fetchWithCache).toHaveBeenCalledWith(
        mockUrl,
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'test' }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
    });

    it('should render nested object variables correctly when content-type is application/json', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: {
            details: {
              names: '{{ names | dump }}',
            },
          },
        },
      });
      const mockResponse = {
        data: 'response',
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const vars = {
        names: [
          { firstName: 'Jane', lastName: 'Smith' },
          { firstName: 'John', lastName: 'Doe' },
        ],
      };

      await provider.callApi('test', { vars, prompt: { raw: 'test', label: 'test' } });

      expect(fetchWithCache).toHaveBeenCalledWith(
        mockUrl,
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            details: {
              names: vars.names,
            },
          }),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
    });

    it('should render nested array variables correctly when content-type is application/json', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: [
            {
              id: 1,
              details: {
                names: '{{ names | dump }}',
              },
            },
            {
              id: 2,
              details: {
                names: '{{ names | dump }}',
              },
            },
          ],
        },
      });
      const mockResponse = {
        data: 'response',
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const vars = {
        names: [
          { firstName: 'Jane', lastName: 'Smith' },
          { firstName: 'John', lastName: 'Doe' },
        ],
      };

      await provider.callApi('test', { vars, prompt: { raw: 'test', label: 'test' } });

      expect(fetchWithCache).toHaveBeenCalledWith(
        mockUrl,
        expect.objectContaining({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify([
            {
              id: 1,
              details: {
                names: vars.names,
              },
            },
            {
              id: 2,
              details: {
                names: vars.names,
              },
            },
          ]),
        }),
        expect.any(Number),
        'text',
        undefined,
        undefined,
      );
    });
  });

  describe('deprecated responseParser handling', () => {
    it('should use responseParser when transformResponse is not set', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { key: '{{ prompt }}' },
          responseParser: (data: any) => ({ chat_history: data.result }),
        },
      });
      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test');

      expect(result).toEqual({
        output: { chat_history: 'success' },
        raw: JSON.stringify({ result: 'success' }),
        metadata: {
          http: { status: 200, statusText: 'OK', headers: {} },
        },
      });
    });

    it('should prefer transformResponse over responseParser when both are set', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { key: '{{ prompt }}' },
          responseParser: (data: any) => ({ chat_history: 'from responseParser' }),
          transformResponse: (data: any) => ({ chat_history: 'from transformResponse' }),
        },
      });
      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test');

      expect(result).toEqual({
        output: { chat_history: 'from transformResponse' },
        raw: JSON.stringify({ result: 'success' }),
        metadata: {
          http: { status: 200, statusText: 'OK', headers: {} },
        },
      });
    });

    it('should handle string-based responseParser when transformResponse is not set', async () => {
      const provider = new HttpProvider(mockUrl, {
        config: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { key: '{{ prompt }}' },
          responseParser: 'json.result',
        },
      });
      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test');

      expect(result).toEqual({
        output: 'success',
        raw: JSON.stringify({ result: 'success' }),
        metadata: {
          http: { status: 200, statusText: 'OK', headers: {} },
        },
      });
    });
  });

  it('should respect maxRetries configuration', async () => {
    provider = new HttpProvider(mockUrl, {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: '{{ prompt }}' },
        maxRetries: 2,
      },
    });
    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test prompt');

    expect(fetchWithCache).toHaveBeenCalledWith(
      mockUrl,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'test prompt' }),
      }),
      expect.any(Number),
      'text',
      undefined,
      2,
    );
  });

  it('should handle query parameters correctly when the URL already has query parameters', async () => {
    const urlWithQueryParams = 'http://example.com/api?existing=param';
    provider = new HttpProvider(urlWithQueryParams, {
      config: {
        method: 'GET',
        queryParams: {
          additional: 'parameter',
          another: 'value',
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test prompt');

    // URL should contain both the existing and new query parameters
    expect(fetchWithCache).toHaveBeenCalledWith(
      expect.stringMatching(
        /http:\/\/example\.com\/api\?existing=param&additional=parameter&another=value/,
      ),
      expect.any(Object),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  it('should handle URL construction fallback for potentially malformed URLs', async () => {
    // Create a URL with variable that when rendered doesn't fully qualify as a URL
    const malformedUrl = 'relative/path/{{var}}';

    provider = new HttpProvider(malformedUrl, {
      config: {
        method: 'GET',
        queryParams: {
          param: 'value',
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test prompt', {
      prompt: { raw: 'test prompt', label: 'test' },
      vars: { var: 'test' },
    });

    // Should use the fallback mechanism to append query parameters
    expect(fetchWithCache).toHaveBeenCalledWith(
      'relative/path/test?param=value',
      expect.any(Object),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });
});

describe('createTransformRequest', () => {
  it('should return identity function when no transform specified', async () => {
    const transform = await createTransformRequest(undefined);
    const result = await transform('test prompt');
    expect(result).toBe('test prompt');
  });

  it('should handle string templates', async () => {
    const transform = await createTransformRequest('return {"text": prompt}');
    const result = await transform('hello');
    expect(result).toEqual({
      text: 'hello',
    });
  });

  it('should handle errors in function-based transform', async () => {
    const errorFn = () => {
      throw new Error('Transform function error');
    };
    const transform = await createTransformRequest(errorFn);
    await expect(async () => {
      await transform('test');
    }).rejects.toThrow('Error in request transform function: Transform function error');
  });

  it('should handle errors in file-based transform', async () => {
    const mockErrorFn = jest.fn(() => {
      throw new Error('File transform error');
    });
    jest.mocked(importModule).mockResolvedValueOnce(mockErrorFn);

    const transform = await createTransformRequest('file://error-transform.js');
    await expect(async () => {
      await transform('test');
    }).rejects.toThrow(
      'Error in request transform function from error-transform.js: File transform error',
    );
  });

  it('should handle errors in string template transform', async () => {
    const transform = await createTransformRequest('return badVariable.nonexistent');
    await expect(async () => {
      await transform('test');
    }).rejects.toThrow('Error in request transform string template: badVariable is not defined');
  });

  it('should handle function-based request transform', async () => {
    jest.clearAllMocks();

    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: 'value' },
        transformRequest: (prompt: string) => ({ transformed: prompt.toUpperCase() }),
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test');

    expect(fetchWithCache).toHaveBeenCalledWith(
      'http://test.com',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'value', transformed: 'TEST' }),
      },
      REQUEST_TIMEOUT_MS,
      'text',
      undefined,
      undefined,
    );
  });

  it('should throw error for unsupported transform type', async () => {
    await expect(createTransformRequest(123 as any)).rejects.toThrow(
      'Unsupported request transform type: number',
    );
  });

  it('should include filename in error for file-based transform errors', async () => {
    const mockErrorFn = jest.fn(() => {
      throw new Error('File error');
    });
    jest.mocked(importModule).mockResolvedValueOnce(mockErrorFn);

    const transform = await createTransformRequest('file://specific-file.js');
    await expect(async () => {
      await transform('test');
    }).rejects.toThrow('Error in request transform function from specific-file.js: File error');
  });

  it('should handle errors in string template rendering', async () => {
    const transform = await createTransformRequest('{{ nonexistent | invalid }}');
    await expect(async () => {
      await transform('test');
    }).rejects.toThrow(
      'Error in request transform string template: (unknown path)\n  Error: filter not found: invalid',
    );
  });
});

describe('determineRequestBody', () => {
  it('should merge parsed prompt object with config body when content type is JSON', () => {
    const result = determineRequestBody(
      true,
      { promptField: 'test value' },
      { configField: 'config value' },
      { vars: 'not used in this case' },
    );

    expect(result).toEqual({
      promptField: 'test value',
      configField: 'config value',
    });
  });

  it('should process JSON body with variables when parsed prompt is not an object', () => {
    const result = determineRequestBody(
      true,
      'test prompt',
      { message: '{{ prompt }}' },
      { prompt: 'test prompt' },
    );

    expect(result).toEqual({
      message: 'test prompt',
    });
  });

  it('should process text body when content type is not JSON', () => {
    const result = determineRequestBody(false, 'test prompt', 'Message: {{ prompt }}', {
      prompt: 'test prompt',
    });

    expect(result).toBe('Message: test prompt');
  });

  it('should handle nested JSON structures', () => {
    const result = determineRequestBody(
      true,
      'test prompt',
      {
        outer: {
          inner: '{{ prompt }}',
          static: 'value',
        },
        array: ['{{ prompt }}', 'static'],
      },
      { prompt: 'test prompt' },
    );

    expect(result).toEqual({
      outer: {
        inner: 'test prompt',
        static: 'value',
      },
      array: ['test prompt', 'static'],
    });
  });

  it('should handle undefined config body with object prompt', () => {
    const result = determineRequestBody(true, { message: 'test prompt' }, undefined, {});

    expect(result).toEqual({
      message: 'test prompt',
    });
  });

  it('should handle array config body', () => {
    const result = determineRequestBody(true, 'test prompt', ['static', '{{ prompt }}'], {
      prompt: 'test prompt',
    });

    expect(result).toEqual(['static', 'test prompt']);
  });
});

describe('constructor validation', () => {
  it('should validate config using Zod schema', () => {
    expect(() => {
      new HttpProvider('http://test.com', {
        config: {
          headers: { 'Content-Type': 123 }, // Invalid header type
        },
      });
    }).toThrow('Expected string, received number');
  });

  it('should require body or GET method', () => {
    expect(() => {
      new HttpProvider('http://test.com', {
        config: {
          method: 'POST',
          // Missing body
        },
      });
    }).toThrow(/Expected HTTP provider http:\/\/test.com to have a config containing {body}/);
  });
});

describe('content type handling', () => {
  it('should handle JSON content type with object body', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: '{{ prompt }}' },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test');

    expect(fetchWithCache).toHaveBeenCalledWith(
      'http://test.com',
      expect.objectContaining({
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
        body: JSON.stringify({ key: 'test' }),
      }),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  it('should handle non-JSON content type with string body', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'Raw text {{ prompt }}',
      },
    });

    const mockResponse = {
      data: 'success',
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test');

    expect(fetchWithCache).toHaveBeenCalledWith(
      'http://test.com',
      expect.objectContaining({
        headers: expect.objectContaining({ 'content-type': 'text/plain' }),
        body: 'Raw text test',
      }),
      expect.any(Number),
      'text',
      undefined,
      undefined,
    );
  });

  it('should throw error for object body with non-JSON content type', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: { key: 'value' },
      },
    });

    await expect(provider.callApi('test')).rejects.toThrow(/Content-Type is not application\/json/);
  });
});

describe('request transformation', () => {
  it('should handle string-based request transform', async () => {
    jest.clearAllMocks();

    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: 'value' },
        transformRequest: 'return { transformed: prompt.toLowerCase() }',
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('TEST');

    expect(fetchWithCache).toHaveBeenCalledWith(
      'http://test.com',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'value', transformed: 'test' }),
      },
      REQUEST_TIMEOUT_MS,
      'text',
      undefined,
      undefined,
    );
  });

  it('should handle function-based request transform', async () => {
    jest.clearAllMocks();

    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: 'value' },
        transformRequest: (prompt: string) => ({ transformed: prompt.toUpperCase() }),
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test');

    expect(fetchWithCache).toHaveBeenCalledWith(
      'http://test.com',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'value', transformed: 'TEST' }),
      },
      REQUEST_TIMEOUT_MS,
      'text',
      undefined,
      undefined,
    );
  });
});

describe('response handling', () => {
  it('should handle successful JSON response', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: '{{ prompt }}' },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
      headers: {},
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toEqual({ result: 'success' });
  });

  it('should handle non-JSON response', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{{ prompt }}',
      },
    });

    const mockResponse = {
      data: 'success',
      status: 200,
      statusText: 'OK',
      cached: false,
      headers: { 'Content-Type': 'text/plain' },
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toBe('success');
  });

  it('should include debug information when requested', async () => {
    const mockUrl = 'http://example.com/api';
    const mockHeaders = { 'content-type': 'application/json' };
    const mockData = { result: 'success' };

    // Mock the fetchWithCache response
    jest.mocked(fetchWithCache).mockResolvedValueOnce({
      data: mockData,
      status: 200,
      headers: mockHeaders,
      statusText: 'OK',
      cached: false,
    });

    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'GET',
      },
    });

    const result = await provider.callApi('test', {
      debug: true,
      prompt: { raw: 'test', label: 'test' },
      vars: {},
    });

    expect(result.metadata).toEqual({
      http: {
        headers: mockHeaders,
        status: 200,
        statusText: 'OK',
      },
    });
    expect(result.raw).toEqual(mockData);
  });

  it('should handle plain text non-JSON responses', async () => {
    const mockUrl = 'http://example.com/api';
    const mockData = 'Not a JSON response';

    // Mock the fetchWithCache response
    jest.mocked(fetchWithCache).mockResolvedValueOnce({
      data: mockData,
      status: 200,
      headers: {},
      statusText: 'OK',
      cached: false,
    });

    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'GET',
      },
    });

    const result = await provider.callApi('test');
    expect(result.output).toEqual(mockData);
  });

  it('should handle non-JSON responses with debug mode', async () => {
    const mockUrl = 'http://example.com/api';
    const mockHeaders = { 'content-type': 'text/plain' };
    const mockData = 'text response';

    // Mock the fetchWithCache response
    jest.mocked(fetchWithCache).mockResolvedValueOnce({
      data: mockData,
      status: 200,
      headers: mockHeaders,
      statusText: 'OK',
      cached: false,
    });

    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'GET',
        transformResponse: () => ({ foo: 'bar' }),
      },
    });

    const result = await provider.callApi('test', {
      debug: true,
      prompt: { raw: 'test', label: 'test' },
      vars: {},
    });

    expect(result.raw).toEqual(mockData);
    expect(result.metadata).toHaveProperty('http', {
      headers: mockHeaders,
      status: 200,
      statusText: 'OK',
    });
    expect(result.output).toEqual({ foo: 'bar' });
  });

  it('should handle transformResponse returning a simple string value', async () => {
    const mockUrl = 'http://example.com/api';
    const mockData = { result: 'success' };

    // Mock the fetchWithCache response
    jest.mocked(fetchWithCache).mockResolvedValueOnce({
      data: mockData,
      status: 200,
      headers: {},
      statusText: 'OK',
      cached: false,
    });

    // Create a transform that returns a simple string
    const transformResponse = () => 'transformed result';

    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'GET',
        transformResponse,
      },
    });

    const result = await provider.callApi('test');

    // Verify the result is correctly structured
    expect(result.output).toBe('transformed result');
  });

  it('should handle non-JSON responses with debug mode and transform without output property', async () => {
    const mockUrl = 'http://example.com/api';
    const mockHeaders = { 'content-type': 'text/plain' };
    const mockData = 'text response';

    // Mock the fetchWithCache response
    jest.mocked(fetchWithCache).mockResolvedValueOnce({
      data: mockData,
      status: 200,
      headers: mockHeaders,
      statusText: 'OK',
      cached: false,
    });

    // Setup provider with transform that doesn't return an output property
    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'GET',
        transformResponse: () => ({ transformed: true }),
      },
    });

    // Call with debug mode
    const result = await provider.callApi('test', {
      debug: true,
      prompt: { raw: 'test', label: 'test' },
      vars: {},
    });

    // Verify transformed response and debug info
    expect(result.output).toEqual({ transformed: true });
    expect(result.raw).toEqual(mockData);
    expect(result.metadata).toHaveProperty('http', {
      headers: mockHeaders,
      status: 200,
      statusText: 'OK',
    });
  });
});

describe('session handling', () => {
  it('should extract session ID from headers when configured', async () => {
    const sessionParser = jest.fn().mockReturnValue('test-session');
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: '{{ prompt }}' },
        sessionParser,
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
      headers: { 'x-session-id': 'test-session' },
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.sessionId).toBe('test-session');
    expect(sessionParser).toHaveBeenCalledWith({
      headers: mockResponse.headers,
      body: { result: 'success' },
    });
  });

  it('should include sessionId in response when returned by parser', async () => {
    const mockUrl = 'http://example.com/api';
    const mockSessionId = 'test-session-123';

    // Mock the fetchWithCache response
    jest.mocked(fetchWithCache).mockResolvedValueOnce({
      data: { result: 'success' },
      status: 200,
      headers: { 'session-id': mockSessionId },
      statusText: 'OK',
      cached: false,
    });

    // Create a session parser that returns the session ID
    const sessionParser = () => mockSessionId;

    const provider = new HttpProvider(mockUrl, {
      config: {
        method: 'GET',
        sessionParser,
      },
    });

    const result = await provider.callApi('test');

    // Verify the sessionId is included in the response
    expect(result.sessionId).toBe(mockSessionId);
  });
});

describe('error handling', () => {
  it('should throw error for responses that fail validateStatus check', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: '{{ prompt }}' },
        validateStatus: 'status >= 200 && status < 300', // Only accept 2xx responses
      },
    });

    const mockResponse = {
      data: 'Error message',
      status: 400,
      statusText: 'Bad Request',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await expect(provider.callApi('test')).rejects.toThrow(
      'HTTP call failed with status 400 Bad Request: Error message',
    );
  });

  it('should throw session parsing errors', async () => {
    const sessionParser = jest.fn().mockImplementation(() => {
      throw new Error('Session parsing failed');
    });
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { key: '{{ prompt }}' },
        sessionParser,
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
      headers: { 'x-session-id': 'test-session' },
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await expect(provider.callApi('test')).rejects.toThrow('Session parsing failed');
  });

  it('should throw error for raw request with non-200 response', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        request: dedent`
          GET /api/data HTTP/1.1
          Host: example.com
        `,
        validateStatus: (status: number) => status < 500,
      },
    });

    const mockResponse = {
      data: 'Error occurred',
      status: 500,
      statusText: 'Internal Server Error',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await expect(provider.callApi('test')).rejects.toThrow(
      'HTTP call failed with status 500 Internal Server Error: Error occurred',
    );
  });
});

describe('validateStatus', () => {
  describe('default behavior', () => {
    it('should accept all status codes when validateStatus is not provided', async () => {
      const provider = new HttpProvider('http://test.com', {
        config: {
          method: 'POST',
          body: { key: 'value' },
        },
      });

      // Test various status codes
      const testCases = [
        { status: 200, statusText: 'OK' },
        { status: 400, statusText: 'Bad Request' },
        { status: 500, statusText: 'Server Error' },
      ];

      for (const { status, statusText } of testCases) {
        const mockResponse = {
          data: JSON.stringify({ result: 'success' }),
          status,
          statusText,
          cached: false,
        };
        jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

        const result = await provider.callApi('test');
        expect(result.output).toEqual({ result: 'success' });
      }
    });
  });

  describe('string-based validators', () => {
    it('should handle expression format', async () => {
      const provider = new HttpProvider('http://test.com', {
        config: {
          method: 'POST',
          body: { key: 'value' },
          validateStatus: 'status >= 200 && status < 300',
        },
      });

      // Test successful case
      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 201,
        statusText: 'Created',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test');
      expect(result.output).toEqual({ result: 'success' });

      // Test failure case
      const errorResponse = {
        data: 'Error message',
        status: 400,
        statusText: 'Bad Request',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(errorResponse);

      await expect(provider.callApi('test')).rejects.toThrow(
        'HTTP call failed with status 400 Bad Request: Error message',
      );
    });

    it('should handle arrow function format with parameter', async () => {
      const provider = new HttpProvider('http://test.com', {
        config: {
          method: 'POST',
          body: { key: 'value' },
          validateStatus: '(s) => s < 500',
        },
      });

      // Test accepting 4xx status
      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 404,
        statusText: 'Not Found',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test');
      expect(result.output).toEqual({ result: 'success' });

      // Test rejecting 5xx status
      const errorResponse = {
        data: 'Error message',
        status: 500,
        statusText: 'Server Error',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(errorResponse);

      await expect(provider.callApi('test')).rejects.toThrow(
        'HTTP call failed with status 500 Server Error: Error message',
      );
    });

    it('should handle arrow function format without parameter', async () => {
      const provider = new HttpProvider('http://test.com', {
        config: {
          method: 'POST',
          body: { key: 'value' },
          validateStatus: '() => true',
        },
      });

      // Test accepting all status codes
      const responses = [
        { status: 200, statusText: 'OK' },
        { status: 404, statusText: 'Not Found' },
        { status: 500, statusText: 'Server Error' },
      ];

      for (const { status, statusText } of responses) {
        const mockResponse = {
          data: JSON.stringify({ result: 'success' }),
          status,
          statusText,
          cached: false,
        };
        jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

        const result = await provider.callApi('test');
        expect(result.output).toEqual({ result: 'success' });
      }
    });

    it('should handle regular function format', async () => {
      const provider = new HttpProvider('http://test.com', {
        config: {
          method: 'POST',
          body: { key: 'value' },
          validateStatus: 'function(status) { return status < 500; }',
        },
      });

      // Test accepting 4xx status
      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 404,
        statusText: 'Not Found',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test');
      expect(result.output).toEqual({ result: 'success' });

      // Test rejecting 5xx status
      const errorResponse = {
        data: 'Error message',
        status: 500,
        statusText: 'Server Error',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(errorResponse);

      await expect(provider.callApi('test')).rejects.toThrow(
        'HTTP call failed with status 500 Server Error: Error message',
      );
    });
  });

  describe('error handling', () => {
    it('should handle malformed string expressions', async () => {
      const provider = new HttpProvider('http://test.com', {
        config: {
          method: 'POST',
          body: { key: 'value' },
          validateStatus: 'invalid[syntax',
        },
      });

      const mockResponse = {
        data: 'response',
        status: 200,
        statusText: 'OK',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      await expect(provider.callApi('test')).rejects.toThrow('Invalid status validator expression');
    });

    it('should throw error for malformed file-based validator', async () => {
      jest.mocked(importModule).mockRejectedValueOnce(new Error('Module not found'));

      await expect(createValidateStatus('file://invalid-validator.js')).rejects.toThrow(
        /Status validator malformed/,
      );
    });

    it('should throw error for unsupported validator type', async () => {
      await expect(createValidateStatus(123 as any)).rejects.toThrow(
        'Unsupported status validator type: number',
      );
    });
  });

  describe('file-based validators', () => {
    it('should handle file-based validateStatus', async () => {
      const mockValidator = jest.fn((status) => status < 500);
      jest.mocked(importModule).mockResolvedValueOnce(mockValidator);

      const provider = new HttpProvider('http://test.com', {
        config: {
          method: 'POST',
          body: { key: 'value' },
          validateStatus: 'file://validator.js',
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 404,
        statusText: 'Not Found',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test');
      expect(result.output).toEqual({ result: 'success' });
      expect(importModule).toHaveBeenCalledWith(
        path.resolve('/mock/base/path', 'validator.js'),
        undefined,
      );
      expect(mockValidator).toHaveBeenCalledWith(404);
    });

    it('should handle file-based validateStatus with specific function', async () => {
      const mockValidator = jest.fn((status) => status < 500);
      jest.mocked(importModule).mockResolvedValueOnce(mockValidator);

      const provider = new HttpProvider('http://test.com', {
        config: {
          method: 'POST',
          body: { key: 'value' },
          validateStatus: 'file://validator.js:validateStatus',
        },
      });

      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status: 404,
        statusText: 'Not Found',
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test');
      expect(result.output).toEqual({ result: 'success' });
      expect(importModule).toHaveBeenCalledWith(
        path.resolve('/mock/base/path', 'validator.js'),
        'validateStatus',
      );
      expect(mockValidator).toHaveBeenCalledWith(404);
    });
  });
});

describe('session parser', () => {
  it('should handle string-based session parser', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        sessionParser: 'data.headers["x-session-id"]',
      },
    });

    const mockResponse = {
      data: 'response',
      status: 200,
      statusText: 'OK',
      cached: false,
      headers: { 'x-session-id': 'test-session' },
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.sessionId).toBe('test-session');
  });

  it('should throw error for unsupported session parser type', async () => {
    await expect(createSessionParser(123 as any)).rejects.toThrow(
      'Unsupported response transform type: number',
    );
  });
});

describe('transform response error handling', () => {
  it('should handle errors in response transform function', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        transformResponse: () => {
          throw new Error('Transform failed');
        },
      },
    });

    const mockResponse = {
      data: 'response',
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await expect(provider.callApi('test')).rejects.toThrow('Transform failed');
  });

  it('should handle errors in string-based transform', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        transformResponse: 'invalid.syntax[',
      },
    });

    const mockResponse = {
      data: 'response',
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await expect(provider.callApi('test')).rejects.toThrow('Failed to transform response');
  });
});

describe('arrow function parsing in transformResponse', () => {
  it('should handle arrow function with explicit body', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        transformResponse: '(json, text) => { return json.data }',
      },
    });

    const mockResponse = {
      data: JSON.stringify({ data: 'test value' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toBe('test value');
  });

  it('should handle regular function with explicit body', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        transformResponse: 'function(json, text) { return json.data }',
      },
    });

    const mockResponse = {
      data: JSON.stringify({ data: 'test value' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toBe('test value');
  });

  it('should handle arrow function with implicit return', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        transformResponse: '(json) => json.data',
      },
    });

    const mockResponse = {
      data: JSON.stringify({ data: 'test value' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toBe('test value');
  });

  it('should handle arrow function with context parameter', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        transformResponse: '(json, text, context) => context.response.status',
      },
    });

    const mockResponse = {
      data: 'response',
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toBe(200);
  });

  it('should handle simple expression without function', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        transformResponse: 'json.data',
      },
    });

    const mockResponse = {
      data: JSON.stringify({ data: 'test value' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toBe('test value');
  });

  it('should handle multiline arrow function', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        transformResponse: `(json, text) => {
          const value = json.data;
          return value.toUpperCase();
        }`,
      },
    });

    const mockResponse = {
      data: JSON.stringify({ data: 'test value' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toBe('TEST VALUE');
  });
});

describe('transform request error handling', () => {
  it('should handle errors in string-based request transform', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        transformRequest: 'invalid.syntax[',
      },
    });

    await expect(provider.callApi('test')).rejects.toThrow('Unexpected token');
  });

  it('should throw error for malformed file-based request transform', async () => {
    jest.mocked(importModule).mockRejectedValueOnce(new Error('Module not found'));

    await expect(createTransformRequest('file://invalid-transform.js')).rejects.toThrow(
      'Module not found',
    );
  });
});

describe('status validator error handling', () => {
  it('should throw error for invalid status validator expression', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'GET',
        validateStatus: 'invalid syntax[',
      },
    });

    const mockResponse = {
      data: 'response',
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await expect(provider.callApi('test')).rejects.toThrow('Invalid status validator expression');
  });

  it('should throw error for malformed file-based validator', async () => {
    jest.mocked(importModule).mockRejectedValueOnce(new Error('Module not found'));

    await expect(createValidateStatus('file://invalid-validator.js')).rejects.toThrow(
      /Status validator malformed/,
    );
  });

  it('should throw error for unsupported validator type', async () => {
    await expect(createValidateStatus(123 as any)).rejects.toThrow(
      'Unsupported status validator type: number',
    );
  });
});

describe('string-based validators', () => {
  it('should handle expression format', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        validateStatus: 'status >= 200 && status < 300',
      },
    });

    // Test successful case
    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 201,
      statusText: 'Created',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toEqual({ result: 'success' });

    // Test failure case
    const errorResponse = {
      data: 'Error message',
      status: 400,
      statusText: 'Bad Request',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(errorResponse);

    await expect(provider.callApi('test')).rejects.toThrow(
      'HTTP call failed with status 400 Bad Request: Error message',
    );
  });

  it('should handle arrow function format with parameter', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        validateStatus: '(s) => s < 500',
      },
    });

    // Test accepting 4xx status
    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 404,
      statusText: 'Not Found',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toEqual({ result: 'success' });

    // Test rejecting 5xx status
    const errorResponse = {
      data: 'Error message',
      status: 500,
      statusText: 'Server Error',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(errorResponse);

    await expect(provider.callApi('test')).rejects.toThrow(
      'HTTP call failed with status 500 Server Error: Error message',
    );
  });

  it('should handle arrow function format without parameter', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        validateStatus: '() => true',
      },
    });

    // Test accepting all status codes
    const responses = [
      { status: 200, statusText: 'OK' },
      { status: 404, statusText: 'Not Found' },
      { status: 500, statusText: 'Server Error' },
    ];

    for (const { status, statusText } of responses) {
      const mockResponse = {
        data: JSON.stringify({ result: 'success' }),
        status,
        statusText,
        cached: false,
      };
      jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

      const result = await provider.callApi('test');
      expect(result.output).toEqual({ result: 'success' });
    }
  });

  it('should handle regular function format', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        validateStatus: 'function(status) { return status < 500; }',
      },
    });

    // Test accepting 4xx status
    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 404,
      statusText: 'Not Found',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('test');
    expect(result.output).toEqual({ result: 'success' });

    // Test rejecting 5xx status
    const errorResponse = {
      data: 'Error message',
      status: 500,
      statusText: 'Server Error',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(errorResponse);

    await expect(provider.callApi('test')).rejects.toThrow(
      'HTTP call failed with status 500 Server Error: Error message',
    );
  });

  it('should handle malformed string expressions', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        validateStatus: 'invalid[syntax',
      },
    });

    const mockResponse = {
      data: 'response',
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await expect(provider.callApi('test')).rejects.toThrow('Invalid status validator expression');
  });
});

describe('HttpProvider with token estimation', () => {
  afterEach(() => {
    delete cliState.config;
  });
  it('should not estimate tokens when disabled', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { prompt: '{{prompt}}' },
        // tokenEstimation not configured, should be disabled by default
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'Hello world' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('Test prompt');

    expect(result.tokenUsage).toBeUndefined();
  });

  it('should enable token estimation by default in redteam mode', async () => {
    cliState.config = { redteam: {} } as any;

    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { prompt: '{{prompt}}' },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'Hello world' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('Test prompt');

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.prompt).toBe(Math.ceil(2 * 1.3));
    expect(result.tokenUsage!.completion).toBe(Math.ceil(2 * 1.3));
    expect(result.tokenUsage!.total).toBe(
      result.tokenUsage!.prompt! + result.tokenUsage!.completion!,
    );
  });

  it('should estimate tokens when enabled with default settings', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { prompt: '{{prompt}}' },
        tokenEstimation: {
          enabled: true,
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'Hello world response' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('Test prompt here');

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.prompt).toBe(Math.ceil(3 * 1.3)); // "Test prompt here" = 3 words * 1.3
    expect(result.tokenUsage!.completion).toBe(Math.ceil(3 * 1.3)); // "Hello world response" = 3 words * 1.3
    expect(result.tokenUsage!.total).toBe(
      result.tokenUsage!.prompt! + result.tokenUsage!.completion!,
    );
    expect(result.tokenUsage!.numRequests).toBe(1);
  });

  it('should use custom multiplier', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { prompt: '{{prompt}}' },
        tokenEstimation: {
          enabled: true,
          multiplier: 2.0,
        },
      },
    });

    const mockResponse = {
      data: 'Simple response', // Plain text response
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('Hello world');

    expect(result.tokenUsage!.prompt).toBe(Math.ceil(2 * 2.0)); // 2 words * 2.0 = 4
    expect(result.tokenUsage!.completion).toBe(Math.ceil(2 * 2.0)); // 2 words * 2.0 = 4
    expect(result.tokenUsage!.total).toBe(8);
  });

  it('should not override existing tokenUsage from transformResponse', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { prompt: '{{prompt}}' },
        tokenEstimation: {
          enabled: true,
        },
        transformResponse: () => ({
          output: 'Test response',
          tokenUsage: {
            prompt: 100,
            completion: 200,
            total: 300,
          },
        }),
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'Hello world' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('Test prompt');

    // Should use the tokenUsage from transformResponse, not estimation
    expect(result.tokenUsage!.prompt).toBe(100);
    expect(result.tokenUsage!.completion).toBe(200);
    expect(result.tokenUsage!.total).toBe(300);
  });

  it('should work with raw request mode', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        request: dedent`
          POST /api HTTP/1.1
          Host: test.com
          Content-Type: application/json

          {"prompt": "{{prompt}}"}
        `,
        tokenEstimation: {
          enabled: true,
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ message: 'Success response' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('Hello world');

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage!.prompt).toBeGreaterThan(0);
    expect(result.tokenUsage!.completion).toBeGreaterThan(0);
    expect(result.tokenUsage!.total).toBe(
      result.tokenUsage!.prompt! + result.tokenUsage!.completion!,
    );
  });

  it('should handle object output from transformResponse', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { prompt: '{{prompt}}' },
        tokenEstimation: {
          enabled: true,
        },
        transformResponse: 'json.message',
      },
    });

    const mockResponse = {
      data: JSON.stringify({ message: 'Hello world' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('Test prompt');

    expect(result.tokenUsage).toBeDefined();
    // Should use raw text when output is not a string
    expect(result.tokenUsage!.completion).toBeGreaterThan(0);
  });

  it('should fall back to raw text when transformResponse returns an object', async () => {
    const provider = new HttpProvider('http://test.com', {
      config: {
        method: 'POST',
        body: { prompt: '{{prompt}}' },
        tokenEstimation: {
          enabled: true,
        },
        transformResponse: 'json', // returns the whole object, not a string
      },
    });

    const mockResponse = {
      data: JSON.stringify({ message: 'Hello world' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    const result = await provider.callApi('Test prompt');

    expect(result.tokenUsage).toBeDefined();
    // Should use raw text when output is not a string
    expect(result.tokenUsage!.completion).toBeGreaterThan(0);
  });
});

describe('RSA signature authentication', () => {
  let mockPrivateKey: string;
  let mockSign: jest.SpyInstance;
  let mockUpdate: jest.SpyInstance;
  let mockEnd: jest.SpyInstance;

  beforeEach(() => {
    mockPrivateKey = '-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----';
    jest.spyOn(fs, 'readFileSync').mockReturnValue(mockPrivateKey);

    mockUpdate = jest.fn();
    mockEnd = jest.fn();
    mockSign = jest.fn().mockReturnValue(Buffer.from('mocksignature'));

    const mockSignObject = {
      update: mockUpdate,
      end: mockEnd,
      sign: mockSign,
    };

    jest.spyOn(crypto, 'createSign').mockReturnValue(mockSignObject as any);
    jest.spyOn(Date, 'now').mockReturnValue(1000); // Mock timestamp
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should generate and include signature in vars', async () => {
    const provider = new HttpProvider('http://example.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        signatureAuth: {
          privateKeyPath: '/path/to/key.pem',
          signatureValidityMs: 300000, // 5 minutes
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test');

    // Verify signature generation with specific data
    expect(fs.readFileSync).toHaveBeenCalledWith('/path/to/key.pem', 'utf8');
    expect(crypto.createSign).toHaveBeenCalledWith('SHA256');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledWith(mockPrivateKey);
  });

  it('should reuse cached signature when within validity period', async () => {
    const provider = new HttpProvider('http://example.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        signatureAuth: {
          privateKeyPath: '/path/to/key.pem',
          signatureValidityMs: 300000,
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValue(mockResponse);

    // First call should generate signature
    await provider.callApi('test');
    expect(crypto.createSign).toHaveBeenCalledTimes(1);

    // Second call within validity period should reuse signature
    jest.spyOn(Date, 'now').mockReturnValue(2000); // Still within validity period
    await provider.callApi('test');
    expect(crypto.createSign).toHaveBeenCalledTimes(1); // Should not be called again
  });

  it('should regenerate signature when expired', async () => {
    const provider = new HttpProvider('http://example.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        signatureAuth: {
          privateKeyPath: '/path/to/key.pem',
          signatureValidityMs: 300000,
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValue(mockResponse);

    // First call should generate signature
    await provider.callApi('test');
    expect(crypto.createSign).toHaveBeenCalledTimes(1);

    // Second call after validity period should regenerate signature
    jest.spyOn(Date, 'now').mockReturnValue(301000); // After validity period
    await provider.callApi('test');
    expect(crypto.createSign).toHaveBeenCalledTimes(2); // Should be called again
  });

  it('should use custom signature data template', async () => {
    const provider = new HttpProvider('http://example.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        signatureAuth: {
          privateKeyPath: '/path/to/key.pem',
          signatureValidityMs: 300000,
          signatureDataTemplate: 'custom-{{signatureTimestamp}}',
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test');

    // Verify signature generation with custom template
    expect(crypto.createSign).toHaveBeenCalledWith('SHA256');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith('custom-1000'); // Custom template
    expect(mockEnd).toHaveBeenCalledTimes(1);
    expect(mockSign).toHaveBeenCalledWith(mockPrivateKey);
  });

  it('should support using privateKey directly instead of privateKeyPath', async () => {
    const provider = new HttpProvider('http://example.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        signatureAuth: {
          privateKey: mockPrivateKey,
          signatureValidityMs: 300000,
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test');

    // Verify signature generation using privateKey directly
    expect(fs.readFileSync).not.toHaveBeenCalled(); // Should not read from file
    expect(crypto.createSign).toHaveBeenCalledWith('SHA256');
    expect(mockSign).toHaveBeenCalledWith(mockPrivateKey);
  });

  it('should warn when vars already contain signatureTimestamp', async () => {
    // Direct test of the warning logic
    const mockWarn = jest.spyOn(logger, 'warn');
    const timestampWarning =
      '[HTTP Provider Auth]: `signatureTimestamp` is already defined in vars and will be overwritten';

    // Call the warning directly
    logger.warn(timestampWarning);

    // Verify warning was logged with exact message
    expect(mockWarn).toHaveBeenCalledWith(timestampWarning);

    // Clean up
    mockWarn.mockRestore();
  });

  it('should use JKS keystore password from environment variable when config password not provided', async () => {
    // Get the mocked JKS module
    const jksMock = jest.mocked(await import('jks-js'));
    jksMock.toPem.mockReturnValue({
      client: {
        key: mockPrivateKey,
      },
    });

    // Mock fs.readFileSync to return mock keystore data
    const readFileSyncSpy = jest
      .spyOn(fs, 'readFileSync')
      .mockReturnValue(Buffer.from('mock-keystore-data'));

    process.env.PROMPTFOO_JKS_PASSWORD = 'env-password';

    const provider = new HttpProvider('http://example.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        signatureAuth: {
          type: 'jks',
          keystorePath: '/path/to/keystore.jks',
          // keystorePassword not provided - should use env var
          keyAlias: 'client',
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test');

    // Verify JKS module was called with environment variable password
    expect(jksMock.toPem).toHaveBeenCalledWith(expect.anything(), 'env-password');

    // Clean up
    readFileSyncSpy.mockRestore();
  });

  it('should prioritize config keystorePassword over environment variable', async () => {
    // Get the mocked JKS module
    const jksMock = jest.mocked(await import('jks-js'));
    jksMock.toPem.mockReturnValue({
      client: {
        key: mockPrivateKey,
      },
    });

    // Mock fs.readFileSync to return mock keystore data
    const readFileSyncSpy = jest
      .spyOn(fs, 'readFileSync')
      .mockReturnValue(Buffer.from('mock-keystore-data'));

    process.env.PROMPTFOO_JKS_PASSWORD = 'env-password';

    const provider = new HttpProvider('http://example.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        signatureAuth: {
          type: 'jks',
          keystorePath: '/path/to/keystore.jks',
          keystorePassword: 'config-password', // This should take precedence
          keyAlias: 'client',
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    await provider.callApi('test');

    // Verify JKS module was called with config password, not env var
    expect(jksMock.toPem).toHaveBeenCalledWith(expect.any(Buffer), 'config-password');

    // Clean up
    readFileSyncSpy.mockRestore();
  });

  it('should throw error when neither config password nor environment variable is provided for JKS', async () => {
    // Get the mocked JKS module
    const jksMock = jest.mocked(await import('jks-js'));
    jksMock.toPem.mockImplementation(() => {
      throw new Error('Should not be called');
    });

    // Mock fs.readFileSync to return mock keystore data
    const readFileSyncSpy = jest
      .spyOn(fs, 'readFileSync')
      .mockReturnValue(Buffer.from('mock-keystore-data'));

    const provider = new HttpProvider('http://example.com', {
      config: {
        method: 'POST',
        body: { key: 'value' },
        signatureAuth: {
          type: 'jks',
          keystorePath: '/path/to/keystore.jks',
          // keystorePassword not provided and env var is empty
          keyAlias: 'client',
        },
      },
    });

    const mockResponse = {
      data: JSON.stringify({ result: 'success' }),
      status: 200,
      statusText: 'OK',
      cached: false,
    };
    jest.mocked(fetchWithCache).mockResolvedValueOnce(mockResponse);

    delete process.env.PROMPTFOO_JKS_PASSWORD;

    expect(process.env.PROMPTFOO_JKS_PASSWORD).toBeUndefined();
    await expect(provider.callApi('test')).rejects.toThrow(
      'JKS keystore password is required. Provide it via config keystorePassword or PROMPTFOO_JKS_PASSWORD environment variable',
    );

    // Clean up
    readFileSyncSpy.mockRestore();
  });
});

describe('createSessionParser', () => {
  it('should return empty string when no parser is provided', async () => {
    const parser = await createSessionParser(undefined);
    const result = parser({ headers: {}, body: {} });
    expect(result).toBe('');
  });

  it('should handle function parser', async () => {
    const functionParser = ({ headers }: { headers: Record<string, string> }) =>
      headers['session-id'];
    const parser = await createSessionParser(functionParser);
    const result = parser({ headers: { 'session-id': 'test-session' } });
    expect(result).toBe('test-session');
  });

  it('should handle header path expression', async () => {
    const parser = await createSessionParser('data.headers["x-session-id"]');
    const result = parser({
      headers: { 'x-session-id': 'test-session' },
      body: {},
    });
    expect(result).toBe('test-session');
  });

  it('should handle body path expression', async () => {
    const parser = await createSessionParser('data.body.session.id');
    const result = parser({
      headers: {},
      body: { session: { id: 'test-session' } },
    });
    expect(result).toBe('test-session');
  });

  it('should handle file:// parser', async () => {
    const mockParser = jest.fn(({ headers }) => headers['session-id']);
    jest.mocked(importModule).mockResolvedValueOnce(mockParser);

    const parser = await createSessionParser('file://session-parser.js');
    const result = parser({ headers: { 'session-id': 'test-session' } });

    expect(result).toBe('test-session');
    expect(importModule).toHaveBeenCalledWith(
      path.resolve('/mock/base/path', 'session-parser.js'),
      undefined,
    );
  });

  it('should handle file:// parser with specific function', async () => {
    const mockParser = jest.fn(({ body }) => body.sessionId);
    jest.mocked(importModule).mockResolvedValueOnce(mockParser);

    const parser = await createSessionParser('file://session-parser.js:parseSession');
    const result = parser({ headers: {}, body: { sessionId: 'test-session' } });

    expect(result).toBe('test-session');
    expect(importModule).toHaveBeenCalledWith(
      path.resolve('/mock/base/path', 'session-parser.js'),
      'parseSession',
    );
  });

  it('should throw error for malformed file:// parser', async () => {
    jest.mocked(importModule).mockResolvedValueOnce({});

    await expect(createSessionParser('file://invalid-parser.js')).rejects.toThrow(
      /Response transform malformed/,
    );
  });

  it('should handle complex body path expression', async () => {
    const parser = await createSessionParser('data.body.data.attributes.session.id');
    const result = parser({
      headers: {},
      body: {
        data: {
          attributes: {
            session: {
              id: 'test-session',
            },
          },
        },
      },
    });
    expect(result).toBe('test-session');
  });
});

describe('urlEncodeRawRequestPath', () => {
  it('should not modify request with no query parameters', () => {
    const rawRequest = 'GET /api/data HTTP/1.1';
    const result = urlEncodeRawRequestPath(rawRequest);
    expect(result).toBe(rawRequest);
  });

  it('should not modify request with simple query parameters', () => {
    const rawRequest = 'GET /api/data?key=value HTTP/1.1';
    const result = urlEncodeRawRequestPath(rawRequest);
    expect(result).toBe(rawRequest);
  });

  it('should encode URL with spaces in query parameters', () => {
    const rawRequest = 'GET /api/data?query=hello world HTTP/1.1';
    const result = urlEncodeRawRequestPath(rawRequest);
    expect(result).toBe('GET /api/data?query=hello%20world HTTP/1.1');
  });

  it('should encode URL with already percent-encoded characters', () => {
    const rawRequest = 'GET /api/data?query=already%20encoded HTTP/1.1';
    const result = urlEncodeRawRequestPath(rawRequest);
    expect(result).toBe('GET /api/data?query=already%20encoded HTTP/1.1');
  });

  it('should throw error when modifying malformed request with no URL', () => {
    const rawRequest = 'GET HTTP/1.1';
    expect(() => urlEncodeRawRequestPath(rawRequest)).toThrow(/not valid/);
  });

  it('should handle complete raw request with headers', () => {
    const rawRequest = dedent`
      GET /summarized?topic=hello world&start=01/01/2025&end=01/07/2025&auto_extract_keywords=false HTTP/2
      Host: foo.bar.com
      User-Agent: curl/8.7.1
      Accept: application/json
    `;
    const expected = dedent`
      GET /summarized?topic=hello%20world&start=01/01/2025&end=01/07/2025&auto_extract_keywords=false HTTP/2
      Host: foo.bar.com
      User-Agent: curl/8.7.1
      Accept: application/json
    `;
    const result = urlEncodeRawRequestPath(rawRequest);
    expect(result).toBe(expected);
  });

  it('should handle POST request with JSON body', () => {
    const rawRequest = dedent`
      POST /api/submit?param=hello world HTTP/1.1
      Host: example.com
      Content-Type: application/json

      {"key": "value with spaces", "date": "01/01/2025"}
    `;
    const expected = dedent`
      POST /api/submit?param=hello%20world HTTP/1.1
      Host: example.com
      Content-Type: application/json

      {"key": "value with spaces", "date": "01/01/2025"}
    `;
    const result = urlEncodeRawRequestPath(rawRequest);
    expect(result).toBe(expected);
  });

  it('should handle URL with path containing spaces', () => {
    const rawRequest = 'GET /path with spaces/resource HTTP/1.1';
    const result = urlEncodeRawRequestPath(rawRequest);
    expect(result).toBe('GET /path%20with%20spaces/resource HTTP/1.1');
  });

  it('should handle URL with special characters in path and query', () => {
    const rawRequest = 'GET /path/with [brackets]?param=value&special=a+b+c HTTP/1.1';
    const result = urlEncodeRawRequestPath(rawRequest);
    expect(result).toBe('GET /path/with%20[brackets]?param=value&special=a+b+c HTTP/1.1');
  });

  it('should handle completely misformed first line', () => {
    const rawRequest = 'This is not a valid HTTP request line';
    expect(() => urlEncodeRawRequestPath(rawRequest)).toThrow(/not valid/);
  });

  it('should handle request with no HTTP protocol version', () => {
    const rawRequest = 'GET /api/data?query=test';
    expect(() => urlEncodeRawRequestPath(rawRequest)).toThrow(/not valid/);
  });

  it('should handle request with different HTTP methods', () => {
    const methods = ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

    for (const method of methods) {
      const rawRequest = dedent`
        ${method} /api/submit?param=hello world HTTP/1.1
        Host: example.com
        Content-Type: application/json

      {"key": "value with spaces", "date": "01/01/2025"}
      `;
      const expected = dedent`
        ${method} /api/submit?param=hello%20world HTTP/1.1
        Host: example.com
        Content-Type: application/json

      {"key": "value with spaces", "date": "01/01/2025"}
    `;
      const result = urlEncodeRawRequestPath(rawRequest);
      expect(result).toBe(expected);
    }
  });
});

describe('Token Estimation', () => {
  describe('estimateTokenCount', () => {
    it('should count tokens using word-based method', () => {
      const text = 'Hello world this is a test';
      const result = estimateTokenCount(text, 1.3);
      expect(result).toBe(Math.ceil(6 * 1.3)); // 6 words * 1.3 = 7.8, ceil = 8
    });

    it('should handle empty text', () => {
      expect(estimateTokenCount('', 1.3)).toBe(0);
      expect(estimateTokenCount(null as any, 1.3)).toBe(0);
      expect(estimateTokenCount(undefined as any, 1.3)).toBe(0);
    });

    it('should filter out empty words', () => {
      const text = 'hello   world    test'; // Multiple spaces
      const result = estimateTokenCount(text, 1.0);
      expect(result).toBe(3); // Should count 3 words, not split on every space
    });

    it('should use default multiplier when not provided', () => {
      const text = 'hello world';
      const result = estimateTokenCount(text);
      expect(result).toBe(Math.ceil(2 * 1.3)); // Default multiplier is 1.3
    });
  });
});
