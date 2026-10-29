import { useState } from 'react';
import { api, type Segment } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, Field, Modal, MultiSelect, SegmentTag, errorMessage, useToast } from './ui';

/**
 * Creates a translation key. Platform defaults to the workspace tab in view; segments may be
 * picked or created inline. On success the caller opens the new key in the editor.
 */
export function NewKeyDialog({
  open,
  onOpenChange,
  defaultPlatformId,
  segments,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultPlatformId: number | null;
  segments: Segment[];
  onCreated: (id: number) => void;
}) {
  const { can, platforms, sourceLanguage } = useSession();
  const toast = useToast();
  const [identifier, setIdentifier] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [description, setDescription] = useState('');
  const [platformIds, setPlatformIds] = useState<number[]>(defaultPlatformId ? [defaultPlatformId] : []);
  const [segmentIds, setSegmentIds] = useState<number[]>([]);
  const [newSegments, setNewSegments] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setIdentifier('');
    setSourceText('');
    setDescription('');
    setPlatformIds(defaultPlatformId ? [defaultPlatformId] : []);
    setSegmentIds([]);
    setNewSegments([]);
    setError('');
  };
  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const created: number[] = [];
      for (const name of newSegments) {
        const r = await api.post('/api/segments', { name });
        created.push(r.id);
      }
      const r = await api.post('/api/keys', {
        identifier: identifier.trim(),
        sourceText,
        description,
        platformIds,
        segmentIds: [...segmentIds, ...created],
      });
      toast('ok', `Key “${identifier.trim()}” created`);
      reset();
      onOpenChange(false);
      onCreated(r.id);
    } catch (e: any) {
      setError(e.details?.[0] ? `${e.details[0].path}: ${e.details[0].message}` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canSource = can('edit_source');
  const canSegments = can('manage_segments');
  const valid = identifier.trim().length > 0 && platformIds.length > 0;

  return (
    <Modal
      open={open}
      onOpenChange={close}
      wide
      title="New key"
      description="Create a keyword with its English source. Translations are added afterwards in the editor."
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={busy} disabled={!valid}>
            Create key
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="Keyword" htmlFor="nk-id" hint="The resource name used in exports, e.g. new_order. Must be unique on each selected platform.">
            <input id="nk-id" autoFocus className="input font-mono" value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field
            label={`${sourceLanguage?.name ?? 'Source'} text`}
            htmlFor="nk-src"
            hint={canSource ? undefined : 'You don’t have permission to set source strings; an editor with that permission can add it later.'}
          >
            <textarea id="nk-src" className="input h-auto min-h-[80px] py-2" disabled={!canSource} value={sourceText} onChange={(e) => setSourceText(e.target.value)} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Description / translator note" htmlFor="nk-desc" hint="Optional context shown to translators.">
            <input id="nk-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <Field label="Platforms" hint="At least one. Selecting several shares one key and its translations.">
          <MultiSelect label="Platforms" placeholder="Choose platforms" options={platforms.map((p) => ({ value: p.id, label: p.name }))} value={platformIds} onChange={setPlatformIds} />
        </Field>
        {canSegments && (
          <Field label="Segments" hint="Optional. Type a new name and press Enter to create one.">
            <MultiSelect
              label="Segments"
              placeholder="Add segments…"
              options={segments.map((s) => ({ value: s.id, label: s.name }))}
              value={segmentIds}
              onChange={setSegmentIds}
              onCreate={(name) => setNewSegments((c) => [...new Set([...c, name])])}
            />
            {newSegments.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {newSegments.map((n) => (
                  <SegmentTag key={n} name={`${n} (new)`} onRemove={() => setNewSegments(newSegments.filter((x) => x !== n))} />
                ))}
              </div>
            )}
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger md:col-span-2">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
