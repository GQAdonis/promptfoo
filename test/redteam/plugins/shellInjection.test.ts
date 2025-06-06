import {
  ShellInjectionPlugin,
  ShellInjectionGrader,
  PLUGIN_ID,
} from '../../../src/redteam/plugins/shellInjection';
import type { ApiProvider } from '../../../src/types';

describe('ShellInjectionPlugin', () => {
  let mockProvider: ApiProvider;

  beforeEach(() => {
    mockProvider = {
      id: 'test-provider',
      callApi: jest.fn().mockResolvedValue({
        output: 'Prompt: rm -rf /\nPrompt: cat /etc/passwd',
      }),
    } as unknown as ApiProvider;
  });

  it('should generate template with default examples when no examples provided', async () => {
    const plugin = new ShellInjectionPlugin(mockProvider, 'test purpose', 'test_var');
    const template = await plugin['getTemplate']();

    expect(template).toContain('System purpose: tech support bot');
    expect(template).toContain('System purpose: customer service assistant');
    expect(template).toContain('System purpose: e-commerce chatbot');
    expect(template).toContain('System purpose: IT helpdesk assistant');
  });

  it('should return correct assertions for a prompt', () => {
    const plugin = new ShellInjectionPlugin(mockProvider, 'test purpose', 'test_var');
    const assertions = plugin['getAssertions']('test prompt');

    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toEqual({
      type: PLUGIN_ID,
      metric: 'ShellInjection',
    });
  });

  it('should generate test cases with correct plugin ID in assertions', async () => {
    const plugin = new ShellInjectionPlugin(mockProvider, 'test purpose', 'test_var');
    const tests = await plugin.generateTests(2);

    expect(tests).toHaveLength(2);
    tests.forEach((test) => {
      expect(test.assert).toHaveLength(1);
      expect(test.assert?.[0].type).toBe(PLUGIN_ID);
      expect(test.assert?.[0].type).toBe('promptfoo:redteam:shell-injection');
    });
  });
});

describe('ShellInjectionGrader', () => {
  let grader: ShellInjectionGrader;

  beforeEach(() => {
    grader = new ShellInjectionGrader();
  });

  it('should have correct ID', () => {
    expect(grader.id).toBe(PLUGIN_ID);
  });

  it('should have non-empty rubric', () => {
    expect(grader.rubric).toBeTruthy();
    expect(typeof grader.rubric).toBe('string');
  });

  it('should include key evaluation criteria in rubric', () => {
    expect(grader.rubric).toContain('The output should not execute');
    expect(grader.rubric).toContain('Security warnings');
    expect(grader.rubric).toContain('Input validation errors');
  });
});
