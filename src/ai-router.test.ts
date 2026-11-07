import {describe,it,expect,vi,afterEach} from 'vitest';
import {resolveProvider,generate,generateWithFallback} from '../scripts/ai-provider-router.mjs';
afterEach(()=>vi.unstubAllGlobals());
describe('AI provider routing',()=>{
 it('selects fixed endpoints and never accepts arbitrary user-provided URLs',()=>{
  expect(resolveProvider('openai',{OPENAI_API_KEY:'test'}).base).toBe('https://api.openai.com/v1');
  expect(resolveProvider('moonshot',{MOONSHOT_API_KEY:'test'}).defaultModel).toBe('kimi-k3');
  expect(resolveProvider('ollama',{OLLAMA_URL:'http://127.0.0.1:11434/'}).base).toBe('http://127.0.0.1:11434/v1');
  expect(()=>resolveProvider('untrusted',{OPENAI_API_KEY:'test'})).toThrow(/Unsupported/);
 });
 it('never sends a cloud request without its server-side API key',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
  await expect(generate({provider:'openai',model:'gpt-4.1-mini',prompt:'hello',env:{}})).rejects.toThrow(/not configured/);
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('routes an authenticated completion and records returned tokens',async()=>{
  const fetcher=vi.fn().mockResolvedValue({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'{"summary":"ok"}'}}],usage:{prompt_tokens:42,completion_tokens:15}})});
  vi.stubGlobal('fetch',fetcher);
  const result=await generate({provider:'moonshot',model:'kimi-k3',prompt:'Write JSON',json:true,env:{MOONSHOT_API_KEY:'secret-test'}});
  expect(fetcher.mock.calls[0][0]).toBe('https://api.moonshot.ai/v1/chat/completions');
  expect(result.inputTokens).toBe(42);expect(result.outputTokens).toBe(15);
  expect(result.text).toContain('summary');
 });
 it('only falls back when explicitly authorized',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce({ok:false,status:503,text:async()=>'offline'}).mockResolvedValueOnce({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'OK'}}],usage:{}})});
  vi.stubGlobal('fetch',fetcher);
  const settings={provider:'moonshot',model_id:'kimi-k3',fallback_enabled:true,fallback_provider:'openai',fallback_model:'gpt-4.1-mini',local_only:false};
  const result=await generateWithFallback({settings,prompt:'hello',env:{MOONSHOT_API_KEY:'key1',OPENAI_API_KEY:'key2'}});
  expect(result.provider).toBe('openai');expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('never falls back to cloud when local-only is requested',async()=>{
  const fetcher=vi.fn().mockResolvedValue({ok:false,status:503,text:async()=>'offline'});vi.stubGlobal('fetch',fetcher);
  await expect(generateWithFallback({settings:{provider:'ollama',model_id:'qwen3:4b',fallback_enabled:true,fallback_provider:'openai',fallback_model:'gpt-4.1-mini',local_only:true},prompt:'hello',env:{OPENAI_API_KEY:'key'}})).rejects.toThrow(/HTTP 503/);
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
});
