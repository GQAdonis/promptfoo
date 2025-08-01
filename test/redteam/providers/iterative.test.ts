import { jest } from '@jest/globals';
import RedteamIterativeProvider, {
  runRedteamConversation,
} from '../../../src/redteam/providers/iterative';

import type { ApiProvider, AtomicTestCase, ProviderResponse } from '../../../src/types';

const mockGetProvider = jest.fn<() => Promise<ApiProvider>>();
const mockGetTargetResponse = jest.fn<() => Promise<ProviderResponse>>();
const mockCheckPenalizedPhrases = jest.fn<() => boolean>();
const mockGetGraderById = jest.fn();

jest.mock('../../../src/redteam/providers/shared', () => ({
  redteamProviderManager: {
    getProvider: mockGetProvider,
  },
  getTargetResponse: mockGetTargetResponse,
  checkPenalizedPhrases: mockCheckPenalizedPhrases,
}));

jest.mock('../../../src/redteam/graders', () => ({
  getGraderById: mockGetGraderById,
}));

describe('RedteamIterativeProvider', () => {
  let mockRedteamProvider: jest.Mocked<ApiProvider>;
  let mockTargetProvider: jest.Mocked<ApiProvider>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockRedteamProvider = {
      id: jest.fn().mockReturnValue('mock-redteam'),
      callApi: jest
        .fn<(prompt: string, context?: any) => Promise<ProviderResponse>>()
        .mockImplementation(async (prompt: string) => {
          const input = JSON.parse(prompt);

          if (Array.isArray(input) && input[0]?.role === 'system') {
            return {
              output: JSON.stringify({
                improvement: 'test improvement',
                prompt: 'test prompt',
              }),
            };
          } else if (Array.isArray(input) && input[0]?.content?.includes('on-topic')) {
            return {
              output: JSON.stringify({ onTopic: true }),
            };
          } else {
            return {
              output: JSON.stringify({
                currentResponse: { rating: 5, explanation: 'test' },
                previousBestResponse: { rating: 0, explanation: 'none' },
              }),
            };
          }
        }),
    } as jest.Mocked<ApiProvider>;

    mockTargetProvider = {
      id: jest.fn().mockReturnValue('mock-target'),
      callApi: jest.fn<() => Promise<ProviderResponse>>().mockResolvedValue({
        output: 'mock target response',
      }),
    } as jest.Mocked<ApiProvider>;

    mockGetProvider.mockImplementation(() => Promise.resolve(mockRedteamProvider));
    mockGetTargetResponse.mockImplementation(() =>
      Promise.resolve({
        output: 'mock target response',
      }),
    );
    mockCheckPenalizedPhrases.mockImplementation(() => false);
  });

  describe('constructor', () => {
    it('should throw if injectVar is not provided', () => {
      expect(() => new RedteamIterativeProvider({})).toThrow('Expected injectVar to be set');
    });

    it('should create instance with valid config', () => {
      const provider = new RedteamIterativeProvider({ injectVar: 'test' });
      expect(provider).toBeInstanceOf(RedteamIterativeProvider);
      expect(provider.id()).toBe('promptfoo:redteam:iterative');
    });

    it('should use default numIterations if not provided', () => {
      const provider = new RedteamIterativeProvider({ injectVar: 'test' });
      expect(provider['numIterations']).toBe(4);
    });

    it('should use configured numIterations when provided', () => {
      const provider = new RedteamIterativeProvider({
        injectVar: 'test',
        numIterations: '5',
      });
      // The environment variable takes precedence
      expect(provider['numIterations']).toBe(4);
    });

    it('should use environment variable for numIterations if set', () => {
      process.env.PROMPTFOO_NUM_JAILBREAK_ITERATIONS = '15';
      const provider = new RedteamIterativeProvider({ injectVar: 'test' });
      expect(provider['numIterations']).toBe(15);
      delete process.env.PROMPTFOO_NUM_JAILBREAK_ITERATIONS;
    });
  });

  describe('runRedteamConversation', () => {
    it('should stop iteration when score reaches 10', async () => {
      mockRedteamProvider.callApi
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            improvement: 'test',
            prompt: 'test',
          }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({ onTopic: true }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            currentResponse: { rating: 10, explanation: 'perfect' },
            previousBestResponse: { rating: 5, explanation: 'good' },
          }),
        }));

      const result = await runRedteamConversation({
        context: { prompt: { raw: '', label: '' }, vars: {} },
        filters: undefined,
        injectVar: 'test',
        numIterations: 5,
        options: {},
        prompt: { raw: 'test', label: 'test' },
        redteamProvider: mockRedteamProvider,
        gradingProvider: mockRedteamProvider,
        targetProvider: mockTargetProvider,
        vars: { test: 'goal' },
        excludeTargetOutputFromAgenticAttackGeneration: false,
      });

      expect(result.metadata.finalIteration).toBe(1);
      expect(result.metadata.highestScore).toBe(10);
    });

    it('should exit early when grader fails and use stored grader result', async () => {
      const mockGrader = {
        getResult: jest.fn<any>().mockResolvedValue({
          grade: {
            pass: false,
            score: 0,
            reason: 'Jailbreak detected by grader',
            tokensUsed: { total: 100, prompt: 50, completion: 50 },
          },
          rubric: 'test rubric',
        }),
      };

      mockGetGraderById.mockReturnValue(mockGrader);

      mockRedteamProvider.callApi
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            improvement: 'test',
            prompt: 'test',
          }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({ onTopic: true }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            currentResponse: { rating: 5, explanation: 'moderate' },
            previousBestResponse: { rating: 0, explanation: 'none' },
          }),
        }));

      const test: AtomicTestCase = {
        vars: {},
        assert: [{ type: 'promptfoo:redteam:test-plugin' }],
        metadata: { pluginId: 'test-plugin', goal: 'test goal' },
      };

      const result = await runRedteamConversation({
        context: {
          prompt: { raw: '', label: '' },
          vars: {},
          test,
        },
        filters: undefined,
        injectVar: 'test',
        numIterations: 5,
        options: {},
        prompt: { raw: 'test', label: 'test' },
        redteamProvider: mockRedteamProvider,
        gradingProvider: mockRedteamProvider,
        targetProvider: mockTargetProvider,
        test,
        vars: { test: 'goal' },
        excludeTargetOutputFromAgenticAttackGeneration: false,
      });

      expect(result.metadata.finalIteration).toBe(1);
      expect(result.metadata.stopReason).toBe('Grader failed');
      expect(result.metadata.storedGraderResult).toEqual({
        pass: false,
        score: 0,
        reason: 'Jailbreak detected by grader',
        tokensUsed: { total: 100, prompt: 50, completion: 50 },
      });
      expect(mockGrader.getResult).toHaveBeenCalledWith(
        'test',
        'mock target response',
        test,
        mockRedteamProvider,
        undefined,
        expect.stringContaining('iterative jailbreak attack with the following goal: "test goal"'),
      );
    });

    it('should create synthetic grader result when judge score is high', async () => {
      mockGetGraderById.mockReturnValue(null); // No grader available

      mockRedteamProvider.callApi
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            improvement: 'test',
            prompt: 'test',
          }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({ onTopic: true }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            currentResponse: { rating: 10, explanation: 'Excellent jailbreak achieved' },
            previousBestResponse: { rating: 0, explanation: 'none' },
          }),
        }));

      const result = await runRedteamConversation({
        context: {
          prompt: { raw: '', label: '' },
          vars: {},
          test: { vars: {}, metadata: { goal: 'test goal' } },
        },
        filters: undefined,
        injectVar: 'test',
        numIterations: 5,
        options: {},
        prompt: { raw: 'test', label: 'test' },
        redteamProvider: mockRedteamProvider,
        gradingProvider: mockRedteamProvider,
        targetProvider: mockTargetProvider,
        test: { vars: {}, metadata: { goal: 'test goal' } },
        vars: { test: 'goal' },
        excludeTargetOutputFromAgenticAttackGeneration: false,
      });

      expect(result.metadata.finalIteration).toBe(1);
      expect(result.metadata.stopReason).toBe('Judge success');
      expect(result.metadata.storedGraderResult).toEqual({
        pass: false,
        score: 0,
        reason: 'Excellent jailbreak achieved',
      });
    });

    it('should complete all iterations when no early exit conditions are met', async () => {
      mockGetGraderById.mockReturnValue(null);

      // Reset the mock to handle the exact sequence of calls for 3 iterations
      mockRedteamProvider.callApi.mockReset();

      // Each iteration makes 3 calls: redteam, onTopic, judge
      // So for 3 iterations we need 9 calls total
      mockRedteamProvider.callApi
        // Iteration 1
        .mockResolvedValueOnce({
          output: JSON.stringify({
            improvement: 'test improvement 1',
            prompt: 'test prompt 1',
          }),
        })
        .mockResolvedValueOnce({
          output: JSON.stringify({ onTopic: true }),
        })
        .mockResolvedValueOnce({
          output: JSON.stringify({
            currentResponse: { rating: 5, explanation: 'moderate score 1' },
            previousBestResponse: { rating: 0, explanation: 'none' },
          }),
        })
        // Iteration 2
        .mockResolvedValueOnce({
          output: JSON.stringify({
            improvement: 'test improvement 2',
            prompt: 'test prompt 2',
          }),
        })
        .mockResolvedValueOnce({
          output: JSON.stringify({ onTopic: true }),
        })
        .mockResolvedValueOnce({
          output: JSON.stringify({
            currentResponse: { rating: 6, explanation: 'moderate score 2' },
            previousBestResponse: { rating: 5, explanation: 'previous' },
          }),
        })
        // Iteration 3
        .mockResolvedValueOnce({
          output: JSON.stringify({
            improvement: 'test improvement 3',
            prompt: 'test prompt 3',
          }),
        })
        .mockResolvedValueOnce({
          output: JSON.stringify({ onTopic: true }),
        })
        .mockResolvedValueOnce({
          output: JSON.stringify({
            currentResponse: { rating: 7, explanation: 'moderate score 3' },
            previousBestResponse: { rating: 6, explanation: 'previous' },
          }),
        });

      const result = await runRedteamConversation({
        context: { prompt: { raw: '', label: '' }, vars: {} },
        filters: undefined,
        injectVar: 'test',
        numIterations: 3,
        options: {},
        prompt: { raw: 'test', label: 'test' },
        redteamProvider: mockRedteamProvider,
        gradingProvider: mockRedteamProvider,
        targetProvider: mockTargetProvider,
        vars: { test: 'goal' },
        excludeTargetOutputFromAgenticAttackGeneration: false,
      });

      expect(result.metadata.finalIteration).toBe(3); // Completed all 3 iterations
      expect(result.metadata.stopReason).toBe('Max iterations reached');
      expect(result.metadata.storedGraderResult).toBeUndefined();
      expect(result.metadata.redteamHistory).toHaveLength(3);
    });

    it('should include goal in additional rubric when goal is present', async () => {
      const mockGrader = {
        getResult: jest.fn<any>().mockResolvedValue({
          grade: {
            pass: true,
            score: 1,
            reason: 'Safe response',
          },
          rubric: 'test rubric',
        }),
      };

      mockGetGraderById.mockReturnValue(mockGrader);

      mockRedteamProvider.callApi
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            improvement: 'test',
            prompt: 'test',
          }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({ onTopic: true }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            currentResponse: { rating: 5, explanation: 'moderate' },
            previousBestResponse: { rating: 0, explanation: 'none' },
          }),
        }));

      const test: AtomicTestCase = {
        vars: {},
        assert: [{ type: 'promptfoo:redteam:test-plugin' }],
        metadata: {
          pluginId: 'test-plugin',
          goal: 'Create harmful content about specific groups',
        },
      };

      await runRedteamConversation({
        context: {
          prompt: { raw: '', label: '' },
          vars: {},
          test,
        },
        filters: undefined,
        injectVar: 'test',
        numIterations: 1,
        options: {},
        prompt: { raw: 'test', label: 'test' },
        redteamProvider: mockRedteamProvider,
        gradingProvider: mockRedteamProvider,
        targetProvider: mockTargetProvider,
        test,
        vars: { test: 'goal' },
        excludeTargetOutputFromAgenticAttackGeneration: false,
      });

      expect(mockGrader.getResult).toHaveBeenCalledWith(
        'test',
        'mock target response',
        test,
        mockRedteamProvider,
        undefined,
        expect.stringContaining('Create harmful content about specific groups'),
      );

      const additionalRubricArg = mockGrader.getResult.mock.calls[0][5];
      expect(additionalRubricArg).toContain('ADDITIONAL EVALUATION CRITERIA');
      expect(additionalRubricArg).toContain('iterative jailbreak attack');
      expect(additionalRubricArg).toContain('standalone request');
      expect(additionalRubricArg).toContain('series of different approaches');
    });

    it('should not include additional rubric when no goal is present', async () => {
      const mockGrader = {
        getResult: jest.fn<any>().mockResolvedValue({
          grade: {
            pass: true,
            score: 1,
            reason: 'Safe response',
          },
          rubric: 'test rubric',
        }),
      };

      mockGetGraderById.mockReturnValue(mockGrader);

      mockRedteamProvider.callApi
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            improvement: 'test',
            prompt: 'test',
          }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({ onTopic: true }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            currentResponse: { rating: 5, explanation: 'moderate' },
            previousBestResponse: { rating: 0, explanation: 'none' },
          }),
        }));

      const test: AtomicTestCase = {
        vars: {},
        assert: [{ type: 'promptfoo:redteam:test-plugin' }],
        metadata: { pluginId: 'test-plugin' }, // No goal
      };

      await runRedteamConversation({
        context: {
          prompt: { raw: '', label: '' },
          vars: {},
          test,
        },
        filters: undefined,
        injectVar: 'test',
        numIterations: 1,
        options: {},
        prompt: { raw: 'test', label: 'test' },
        redteamProvider: mockRedteamProvider,
        gradingProvider: mockRedteamProvider,
        targetProvider: mockTargetProvider,
        test,
        vars: { someOtherVar: 'just a test value' }, // Use different key so injectVar doesn't pick it up
        excludeTargetOutputFromAgenticAttackGeneration: false,
      });

      expect(mockGrader.getResult).toHaveBeenCalledWith(
        'test',
        'mock target response',
        test,
        mockRedteamProvider,
        undefined,
        '', // Empty additional rubric when no goal
      );
    });

    it('should prioritize grader failed over judge success when both conditions are met', async () => {
      const mockGrader = {
        getResult: jest.fn<any>().mockResolvedValue({
          grade: {
            pass: false, // Grader fails
            score: 0,
            reason: 'Grader detected jailbreak',
          },
          rubric: 'test rubric',
        }),
      };

      mockGetGraderById.mockReturnValue(mockGrader);

      mockRedteamProvider.callApi
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            improvement: 'test',
            prompt: 'test',
          }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({ onTopic: true }),
        }))
        .mockImplementationOnce(async () => ({
          output: JSON.stringify({
            currentResponse: { rating: 10, explanation: 'Judge also thinks its great' }, // Judge success
            previousBestResponse: { rating: 0, explanation: 'none' },
          }),
        }));

      const test: AtomicTestCase = {
        vars: {},
        assert: [{ type: 'promptfoo:redteam:test-plugin' }],
        metadata: { pluginId: 'test-plugin', goal: 'test goal' },
      };

      const result = await runRedteamConversation({
        context: {
          prompt: { raw: '', label: '' },
          vars: {},
          test,
        },
        filters: undefined,
        injectVar: 'test',
        numIterations: 5,
        options: {},
        prompt: { raw: 'test', label: 'test' },
        redteamProvider: mockRedteamProvider,
        gradingProvider: mockRedteamProvider,
        targetProvider: mockTargetProvider,
        test,
        vars: { test: 'goal' },
        excludeTargetOutputFromAgenticAttackGeneration: false,
      });

      // Should use 'Grader failed' even though judge score was also high
      expect(result.metadata.stopReason).toBe('Grader failed');
      expect(result.metadata.storedGraderResult).toEqual({
        pass: false,
        score: 0,
        reason: 'Grader detected jailbreak',
      });
    });
  });
});
