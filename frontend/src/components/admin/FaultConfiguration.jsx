import { useEffect, useMemo, useState } from 'react';
import { testingService } from '../../services/testingService.js';
import { useToast } from '../../context/ToastContext.jsx';
import { getErrorMessage } from '../../utils/errors.js';

const CONSUMER_LABEL = { payment: 'Payment', inventory: 'Inventory', order: 'Order (saga)', email: 'Email' };
const APPLY_TO_LABEL = { ALL: 'All events', TEST_EVENTS: 'Synthetic test events only', REAL_EVENTS: 'Real customer events only' };

/**
 * Fault Injection Panel. Only the parameters relevant to the selected fault are shown.
 * The form is validated here for convenience; the backend validates again (authoritative).
 */
export default function FaultConfiguration({ overview, onChanged }) {
  const toast = useToast();
  const definitions = overview.definitions;
  const [faultType, setFaultType] = useState(definitions[0].faultType);
  const definition = useMemo(() => definitions.find((d) => d.faultType === faultType), [definitions, faultType]);
  const [targetConsumer, setTargetConsumer] = useState(definition.consumers[0]);
  const [failureRate, setFailureRate] = useState('100');
  const [failureCount, setFailureCount] = useState('2');
  const [unlimited, setUnlimited] = useState(false);
  const [delayMs, setDelayMs] = useState('5000');
  const [copies, setCopies] = useState('2');
  const [applyTo, setApplyTo] = useState('TEST_EVENTS');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!definition.consumers.includes(targetConsumer)) setTargetConsumer(definition.consumers[0]);
    setUnlimited(faultType === 'PERSISTENT_FAILURE');
    if (faultType === 'PERSISTENT_FAILURE') setFailureCount('5');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faultType]);

  const has = (p) => definition.params.includes(p);
  const { limits, retryPolicy } = overview;
  const current = overview.faults.find((f) => f.faultType === faultType && f.targetConsumer === targetConsumer);

  function buildPayload() {
    const payload = { faultType, targetConsumer, applyTo };
    const int = (v) => (/^\d+$/.test(String(v).trim()) ? Number(v) : NaN);
    if (has('failureRate')) {
      payload.failureRate = int(failureRate);
      if (!(payload.failureRate >= 1 && payload.failureRate <= 100)) return 'Failure rate must be a whole number from 1 to 100';
    }
    if (has('failureCount')) {
      payload.failureCount = unlimited ? null : int(failureCount);
      if (!unlimited && !(payload.failureCount >= 1 && payload.failureCount <= limits.maxFailureCount)) {
        return `Number must be between 1 and ${limits.maxFailureCount}`;
      }
    }
    if (has('delayMs')) {
      payload.delayMs = int(delayMs);
      if (!(payload.delayMs >= 100 && payload.delayMs <= limits.maxDelayMs)) return `Delay must be between 100 and ${limits.maxDelayMs} ms`;
    }
    if (has('copies')) {
      payload.copies = int(copies);
      if (!(payload.copies >= 1 && payload.copies <= limits.maxDuplicateCopies)) return `Copies must be between 1 and ${limits.maxDuplicateCopies}`;
    }
    return payload;
  }

  const onEnable = async () => {
    const payload = buildPayload();
    if (typeof payload === 'string') return setFormError(payload);
    setFormError('');
    setBusy(true);
    try {
      const res = await testingService.enableFault(payload);
      toast.success(res.message);
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onDisable = async () => {
    setBusy(true);
    try {
      const res = await testingService.disableFault(faultType, targetConsumer);
      toast.success(`${definition.label} disabled on ${targetConsumer}`);
      onChanged(res);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const countLabel = {
    ARTIFICIAL_DELAY: 'Number of delayed attempts',
    DUPLICATE_DELIVERY: 'Number of events to duplicate',
  }[faultType] ?? 'Number of failures';

  return (
    <section className="card panel">
      <h2>Fault Injection Panel</h2>
      <p className="muted small">
        Faults are injected inside the real consumers by the Reliable Event Processor. Retry policy: attempt 1 + {retryPolicy.maxRetries} retries
        = <strong>{retryPolicy.maxAttempts} attempts</strong> maximum (retry delays {retryPolicy.delaysMs.map((d) => `${d / 1000} s`).join(', ')}), then the DLQ.
        Processing timeout: {limits.processingTimeoutMs / 1000} s.
      </p>

      <div className="form-grid">
        <label className="field">
          <span>Select fault</span>
          <select value={faultType} onChange={(e) => setFaultType(e.target.value)} disabled={busy}>
            {definitions.map((d) => (
              <option key={d.faultType} value={d.faultType}>{d.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Target consumer</span>
          <select value={targetConsumer} onChange={(e) => setTargetConsumer(e.target.value)} disabled={busy || definition.consumers.length === 1}>
            {definition.consumers.map((c) => (
              <option key={c} value={c}>{CONSUMER_LABEL[c] ?? c}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="small fault-description">{definition.description}</p>

      <div className="form-grid">
        {has('failureRate') && (
          <label className="field">
            <span>{faultType === 'ARTIFICIAL_DELAY' ? 'Chance of delay (%)' : faultType === 'DUPLICATE_DELIVERY' ? 'Chance of duplicating (%)' : 'Failure rate (%)'}</span>
            <input inputMode="numeric" value={failureRate} onChange={(e) => setFailureRate(e.target.value)} disabled={busy} />
          </label>
        )}
        {has('delayMs') && (
          <label className="field">
            <span>Artificial delay (milliseconds)</span>
            <input inputMode="numeric" value={delayMs} onChange={(e) => setDelayMs(e.target.value)} disabled={busy} />
            <small className="muted">
              {Number(delayMs) > limits.processingTimeoutMs
                ? `Longer than the ${limits.processingTimeoutMs} ms timeout → each delayed attempt times out and is retried.`
                : `Shorter than the ${limits.processingTimeoutMs} ms timeout → processing is just slower.`}
            </small>
          </label>
        )}
        {has('copies') && (
          <label className="field">
            <span>Extra copies per event</span>
            <input inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value)} disabled={busy} />
          </label>
        )}
        {has('failureCount') && (
          <label className="field">
            <span>{countLabel}</span>
            <input inputMode="numeric" value={unlimited ? '' : failureCount} placeholder={unlimited ? 'unlimited' : ''} onChange={(e) => setFailureCount(e.target.value)} disabled={busy || unlimited} />
            <label className="checkbox small">
              <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} disabled={busy} />
              {faultType === 'PERSISTENT_FAILURE' ? 'Always fail while enabled' : 'Unlimited while enabled'}
            </label>
          </label>
        )}
        <label className="field">
          <span>Apply to</span>
          <select value={applyTo} onChange={(e) => setApplyTo(e.target.value)} disabled={busy}>
            {overview.applyToOptions.map((o) => (
              <option key={o} value={o}>{APPLY_TO_LABEL[o] ?? o}</option>
            ))}
          </select>
        </label>
      </div>

      {formError && <div className="alert alert-error">{formError}</div>}
      <div className="actions-row left">
        <button type="button" className="btn btn-danger" onClick={onEnable} disabled={busy}>Enable fault</button>
        <button type="button" className="btn btn-ghost" onClick={onDisable} disabled={busy || !current?.enabled}>Disable fault</button>
      </div>
      <p className="small">
        Current status of <strong>{definition.label}</strong> on <strong>{targetConsumer}</strong>:{' '}
        {current?.active ? <span className="chip chip-danger">ENABLED</span> : current?.exhausted ? <span className="chip chip-neutral">ENABLED · LIMIT REACHED</span> : <span className="chip chip-success">DISABLED</span>}
      </p>
    </section>
  );
}
