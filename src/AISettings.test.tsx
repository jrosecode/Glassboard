import {render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import {AISettings} from './AISettings';
import {DEFAULT_AI_SETTINGS} from './supabase';

function fakeRepo(){
 return {
  getAISettings:vi.fn().mockResolvedValue({...DEFAULT_AI_SETTINGS}),
  saveAISettings:vi.fn().mockResolvedValue(undefined),
  aiProviderKeys:vi.fn().mockResolvedValue([]),
  saveProviderKey:vi.fn().mockResolvedValue(undefined),
  revokeProviderKey:vi.fn().mockResolvedValue(undefined),
  aiWorkerHealth:vi.fn().mockResolvedValue({workerOnline:false,queuedRuns:1,runningRuns:0}),
  aiMonthlyUsage:vi.fn().mockResolvedValue({runs:2,inputTokens:150,outputTokens:42,estimatedCostUsd:0})
 };
}
describe('AI Providers & Models settings',()=>{
 it('loads saved preferences and shows worker health and usage',async()=>{
  const repository=fakeRepo();
  render(<AISettings repo={repository as never} userId="user-1"/>);
  expect(await screen.findByRole('heading',{name:'AI Providers & Models'})).toBeInTheDocument();
  await waitFor(()=>expect(screen.getByText('Worker offline')).toBeInTheDocument());
  expect(screen.getByText('192')).toBeInTheDocument();
  expect(repository.getAISettings).toHaveBeenCalledWith('user-1');
 });
 it('switches to Kimi K3 and saves provider-scoped settings',async()=>{
  const user=userEvent.setup();const repo=fakeRepo();
  render(<AISettings repo={repo as never} userId="user-1"/>);
  await screen.findByRole('heading',{name:'AI Providers & Models'});
  await user.click(screen.getByRole('button',{name:/Moonshot \/ Kimi/}));
  expect(screen.getByLabelText('Model')).toHaveValue('kimi-k3');
  await user.click(screen.getByRole('button',{name:'Save AI settings'}));
  await waitFor(()=>expect(repo.saveAISettings).toHaveBeenCalledWith('user-1',expect.objectContaining({provider:'moonshot',model_id:'kimi-k3'})));
  expect(await screen.findByText(/AI settings saved/)).toBeInTheDocument();
 });
 it('saves and revokes a cloud API key without revealing it',async()=>{
  const user=userEvent.setup();const repo=fakeRepo();
  repo.aiProviderKeys.mockResolvedValueOnce([]).mockResolvedValueOnce(['moonshot']).mockResolvedValueOnce([]);
  render(<AISettings repo={repo as never} userId="user-1"/>);
  await screen.findByRole('heading',{name:'AI Providers & Models'});
  await user.click(screen.getByRole('button',{name:/Moonshot \\/ Kimi/}));
  await user.type(screen.getByLabelText('API key for Moonshot / Kimi'),'sk-test-do-not-store-in-state');
  await user.click(screen.getByRole('button',{name:'Save encrypted key'}));
  await waitFor(()=>expect(repo.saveProviderKey).toHaveBeenCalledWith('moonshot','sk-test-do-not-store-in-state'));
  expect(screen.getByLabelText('API key for Moonshot / Kimi')).toHaveValue('');
  expect(screen.getByText('Account key saved')).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Revoke saved key'}));
  await waitFor(()=>expect(repo.revokeProviderKey).toHaveBeenCalledWith('moonshot'));
  expect(screen.getByText('No account key saved')).toBeInTheDocument();
 });
 it('refuses cloud fallback in local-only mode',async()=>{
  const user=userEvent.setup();const repo=fakeRepo();
  render(<AISettings repo={repo as never} userId="user-1"/>);
  await screen.findByRole('heading',{name:'AI Providers & Models'});
  await user.click(screen.getByRole('checkbox',{name:/Local-only processing/}));
  expect(screen.getByRole('checkbox',{name:/Automatic fallback/})).toBeDisabled();
  await user.click(screen.getByRole('button',{name:'Save AI settings'}));
  await waitFor(()=>expect(repo.saveAISettings).toHaveBeenCalledWith('user-1',expect.objectContaining({local_only:true,fallback_enabled:false})));
 });
 it('shows a real save error instead of claiming success',async()=>{
  const user=userEvent.setup();const repo=fakeRepo();
  repo.saveAISettings.mockRejectedValueOnce(new Error('Permission denied'));
  render(<AISettings repo={repo as never} userId="user-1"/>);
  await screen.findByRole('heading',{name:'AI Providers & Models'});
  await user.click(screen.getByRole('button',{name:'Save AI settings'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
 });
});
