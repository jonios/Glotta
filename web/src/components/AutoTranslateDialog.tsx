import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, Checkbox, Field, Modal, MultiSelect, Select, Skeleton, errorMessage, useDebounced, useToast } from './ui';

export interface AiStatus {
  configured: boolean;
  canUse: boolean;
  workerRunning: boolean;
  models: { standard: string; economy: string | null };
  batchSize: number;
  maxBatchSize: number;
  maxKeysPerJob: number;
  messageBatchMinKeys: number;
  costEstimates: boolean;
  setupHelp: string | null;
}

interface Preview {
  candidates: number;
  eligible: number;
  emptySource: number;
  excluded: { approved: number; hasTranslation: number };
  batches: number;
  batchSize: number;
  mode: 'interactive' | 'message_batches';
  model: string;
  estimate: { inputTokens: number; outputTokens: number; costUsd: number | null; note: string };
}

export const useAiStatus = () => useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<AiStatus>('/api/ai/status'), staleTime: 60_000 });

const OVERWRITE = [
  { value: 'missing', label: 'Only missing translations (recommended)', hint: 'Fills empty translations. Nothing that already has a value is touched.' },
  { value: 'outdated', label: 'Missing + outdated', hint: 'Also re-translates values whose English source changed after they were written.' },
  { value: 'unapproved', label: 'Everything not approved', hint: 'Replaces drafts and values waiting for review, including human work. Approved values are kept.' },
  { value: 'all', label: 'Everything, including approved', hint: 'Replaces every translation in scope. Super Admins only.' },
] as const;
type Overwrite = (typeof OVERWRITE)[number]['value'];

/**
 * Preview-then-confirm dialog for an Auto Translate job: shows how many keys will be sent, what is
 * excluded and why, the model, the processing mode and a rough token estimate before anything starts.
 */
export function AutoTranslateDialog({
  open,
  onOpenChange,
  targetLanguageId,
  keyIds,
  defaultPlatformIds,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  targetLanguageId?: number;
  keyIds?: number[];
  defaultPlatformIds?: number[];
  onStarted: (jobId: number) => void;
}) {
  const { languages, targetLanguages, platforms, sourceLanguage, isAdmin } = useSession();
  const toast = useToast();
  const status = useAiStatus();
  const [target, setTarget] = useState<number | undefined>(targetLanguageId);
  const [source, setSource] = useState<number | undefined>(sourceLanguage?.id);
  const [platformIds, setPlatformIds] = useState<number[]>(defaultPlatformIds ?? []);
  const [overwrite, setOverwrite] = useState<Overwrite>('missing');
  const [tier, setTier] = useState<'standard' | 'economy'>('standard');
  const [resultStatus, setResultStatus] = useState<'needs_review' | 'draft'>('needs_review');
  const [allowBatchApi, setAllowBatchApi] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const targetId = targetLanguageId ?? target;
  const body = {
    targetLanguageId: targetId,
    sourceLanguageId: source,
    platformIds: platformIds.length ? platformIds : undefined,
    keyIds: keyIds?.length ? keyIds : undefined,
    overwrite,
    confirmOverwrite: confirm,
    tier,
    resultStatus,
    mode: allowBatchApi ? 'auto' : 'interactive',
  };
  const debounced = useDebounced(body, 300);
  const destructive = overwrite === 'unapproved' || overwrite === 'all';
  const preview = useQuery({
    queryKey: ['ai-preview', debounced],
    queryFn: () => api.post<Preview>('/api/ai/jobs/preview', { ...debounced, confirmOverwrite: true }),
    enabled: open && !!debounced.targetLanguageId && !!status.data?.canUse,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const p = preview.data;
  const targetLang = languages.find((l) => l.id === targetId);

  const start = async () => {
    setBusy(true);
    try {
      const job = await api.post('/api/ai/jobs', body);
      toast('ok', `Auto Translate started for ${targetLang?.name ?? 'the language'}`);
      onOpenChange(false);
      onStarted(job.id);
    } catch (e: any) {
      if (e.code === 'job_exists' && e.details?.jobId) {
        toast('error', 'A job with the same options is already running — opening it');
        onOpenChange(false);
        onStarted(e.details.jobId);
      } else toast('error', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const notConfigured = status.data && !status.data.configured;
  const canStart = !!p && p.eligible > 0 && !notConfigured && (!destructive || confirm) && !busy;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={keyIds?.length ? `Auto Translate ${keyIds.length} selected key${keyIds.length === 1 ? '' : 's'}` : 'Auto Translate'}
      description="Translations are created with Claude and saved for review — nothing is published until someone approves it."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" icon={Sparkles} onClick={start} loading={busy} disabled={!canStart}>
            {p ? `Translate ${p.eligible.toLocaleString()} key${p.eligible === 1 ? '' : 's'}` : 'Translate'}
          </Button>
        </>
      }
    >
      {notConfigured && (
        <div role="alert" className="mb-4 flex gap-2 rounded border border-warn/40 bg-warn/[0.08] px-3 py-2 text-[13px] text-warn">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span>Auto Translate is not set up. {status.data?.setupHelp}</span>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {!targetLanguageId && (
          <Field label="Target language" htmlFor="at-target">
            <Select id="at-target" value={target ?? ''} onChange={(e) => setTarget(Number(e.target.value) || undefined)}>
              <option value="">Choose…</option>
              {targetLanguages.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.code})
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Translate from" htmlFor="at-source" hint="The source text sent to the model. English is the project's source language.">
          <Select id="at-source" value={source ?? ''} onChange={(e) => setSource(Number(e.target.value))}>
            {languages
              .filter((l) => l.id !== targetId)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.code}){l.isSource ? ' — source' : ''}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Platforms" hint="Leave empty for all your platforms. A key shared by several platforms is translated once.">
          <MultiSelect label="Platforms" placeholder="All my platforms" options={platforms.map((pl) => ({ value: pl.id, label: pl.name }))} value={platformIds} onChange={setPlatformIds} />
        </Field>
        <Field label="Existing translations" htmlFor="at-overwrite" hint={OVERWRITE.find((o) => o.value === overwrite)?.hint}>
          <Select
            id="at-overwrite"
            value={overwrite}
            onChange={(e) => {
              setOverwrite(e.target.value as Overwrite);
              setConfirm(false);
            }}
          >
            {OVERWRITE.filter((o) => o.value !== 'all' || isAdmin).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Save results as" htmlFor="at-status" hint="Either way the public API keeps serving approved translations only.">
          <Select id="at-status" value={resultStatus} onChange={(e) => setResultStatus(e.target.value as 'needs_review' | 'draft')}>
            <option value="needs_review">Needs review (appears in the Review queue)</option>
            <option value="draft">Draft</option>
          </Select>
        </Field>
        {status.data?.models.economy && (
          <Field label="Model" htmlFor="at-tier">
            <Select id="at-tier" value={tier} onChange={(e) => setTier(e.target.value as 'standard' | 'economy')}>
              <option value="standard">Standard — {status.data.models.standard}</option>
              <option value="economy">Economy — {status.data.models.economy}</option>
            </Select>
          </Field>
        )}
        <div className="md:col-span-2">
          <Checkbox
            label={`Use the Message Batches API for large jobs (from ${status.data?.messageBatchMinKeys.toLocaleString() ?? '…'} keys): half the price, results within about an hour`}
            checked={allowBatchApi}
            onChange={setAllowBatchApi}
            disabled={!status.data?.messageBatchMinKeys}
          />
        </div>
      </div>

      <div className="mt-5 rounded border border-line bg-raised/40 p-4" aria-live="polite">
        <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-subtle">Preview</p>
        {!targetId ? (
          <p className="text-[13px] text-muted">Choose a target language.</p>
        ) : preview.isError ? (
          <p className="text-[13px] text-danger">{errorMessage(preview.error)}</p>
        ) : !p ? (
          <Skeleton className="h-16" />
        ) : (
          <div className="grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
            <Row label="Target">{targetLang ? `${targetLang.name} (${targetLang.code})${targetLang.direction === 'rtl' ? ' · right-to-left' : ''}` : '—'}</Row>
            <Row label="Keys to translate">
              <strong className="text-fg">{p.eligible.toLocaleString()}</strong> of {p.candidates.toLocaleString()} in scope
            </Row>
            <Row label="Left alone">
              {p.excluded.approved.toLocaleString()} approved · {p.excluded.hasTranslation.toLocaleString()} already translated
            </Row>
            <Row label="Skipped">{p.emptySource.toLocaleString()} with an empty source text</Row>
            <Row label="Requests">
              {p.batches.toLocaleString()} batch{p.batches === 1 ? '' : 'es'} of up to {p.batchSize} keys · {p.mode === 'message_batches' ? 'Message Batches API (asynchronous)' : 'immediate'}
            </Row>
            <Row label="Model">{p.model}</Row>
            <Row label="Estimated tokens">
              ~{p.estimate.inputTokens.toLocaleString()} in · ~{p.estimate.outputTokens.toLocaleString()} out
              {p.estimate.costUsd !== null && <> · ≈ ${p.estimate.costUsd.toFixed(2)}</>}
            </Row>
            <p className="text-[12px] text-subtle sm:col-span-2">{p.estimate.note}</p>
            {p.eligible === 0 && <p className="text-[13px] text-warn sm:col-span-2">Nothing to translate with these options.</p>}
          </div>
        )}
      </div>

      {destructive && (
        <div className="mt-4 rounded border border-danger/40 bg-danger/[0.06] p-3">
          <Checkbox
            label={`I understand this replaces ${overwrite === 'all' ? 'existing translations, including approved ones' : 'drafts and values waiting for review, including human work'}. Old values stay in each key's history.`}
            checked={confirm}
            onChange={setConfirm}
          />
        </div>
      )}
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="flex flex-wrap gap-x-2">
      <span className="w-[130px] shrink-0 text-subtle">{label}</span>
      <span className="text-muted">{children}</span>
    </p>
  );
}
