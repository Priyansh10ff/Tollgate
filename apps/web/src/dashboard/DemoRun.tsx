import { useMemo, useState } from "react";
import { usd, type Agent, type DemoStatus, type HubEvent } from "./api";
import { shortUrl } from "./OwnerView";

const RUN_COST = 580_000; // what the default task spends: $0.02 + $0.05 + $0.01 + $0.50

/** One click to start the hosted demo: a wallet, Atlas Data and QuickLeads, ready to run. */
export function TryDemo({ onStart }: { onStart: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="db-card db-setup db-try">
      <div className="db-setup-step">Live demo · about 2 minutes</div>
      <h2 className="serif">Watch an AI agent pay its way</h2>
      <p className="muted">
        You get a Research Agent with a wallet and two data sellers. Fund the wallet with PayPal (sandbox), press Run, and watch Claude buy
        data, ask you before a $0.50 purchase, and get blocked from a site you didn't allow.
      </p>
      <ol className="db-try-steps">
        <li>Add $10 with PayPal</li>
        <li>Run the agent</li>
        <li>Approve the $0.50 report</li>
        <li>Cash out as the seller</li>
      </ol>
      <div className="db-setup-actions">
        <button
          type="button"
          className="db-btn primary glow"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onStart().finally(() => setBusy(false));
          }}
        >
          {busy ? "Setting up…" : "Start the live demo"}
        </button>
      </div>
    </section>
  );
}

/** "HTTP 502\n{"error":"…","charged":false}" → "HTTP 502: … (not charged)" */
function errorText(summary: string): string {
  const [status, ...rest] = summary.split("\n");
  const body = rest.join("\n");
  const message = body.match(/"error"\s*:\s*"([^"]+)/)?.[1];
  const free = /"charged"\s*:\s*false/.test(body);
  return message ? `${status}: ${message}${free ? " (not charged)" : ""}` : summary.split("\n")[0]!;
}

type Line = { id: number; tone: "say" | "call" | "pay" | "wait" | "stop" | "ok" | "err"; text: string };

/** Lines for the latest run of this agent, built from the hub's live events. */
function consoleLines(events: HubEvent[], agentId: string) {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const start = [...ordered].reverse().find((e) => e.type === "agent.started" && e.data.agentId === agentId);
  if (!start) return null;
  const lines: Line[] = [];
  let answer: string | null = null;
  let failed: string | null = null;
  for (const e of ordered) {
    if (e.id < start.id || e.data.agentId !== agentId) continue;
    if (e.type.startsWith("agent.") && e.data.runId !== start.data.runId) continue;
    const d = e.data;
    const what = d.description ?? (d.url ? shortUrl(d.url) : "a request");
    if (e.type === "agent.step" && d.kind === "thought") lines.push({ id: e.id, tone: "say", text: d.text });
    if (e.type === "agent.step" && d.kind === "tool_call")
      lines.push({ id: e.id, tone: "call", text: d.name === "fetch_data" ? `GET ${shortUrl(String(d.input?.url ?? ""))}` : "Checks its wallet and rules" });
    if (e.type === "agent.step" && d.kind === "tool_result" && !d.ok && !/Payment declined/.test(d.summary))
      lines.push({ id: e.id, tone: "err", text: errorText(String(d.summary)) });
    if (e.type === "charge.completed") lines.push({ id: e.id, tone: "pay", text: `Paid ${usd(d.price)} for ${what}` });
    if (e.type === "approval.requested") lines.push({ id: e.id, tone: "wait", text: `Waiting for you to approve ${usd(d.amount)} for ${what}` });
    if (e.type === "approval.approved") lines.push({ id: e.id, tone: "ok", text: "You approved it" });
    if (e.type === "approval.denied") lines.push({ id: e.id, tone: "stop", text: "You denied it" });
    if (e.type === "payment.declined") lines.push({ id: e.id, tone: "stop", text: `Blocked ${usd(d.amount)} to ${d.sellerName}: ${d.reason}` });
    if (e.type === "agent.finished") answer = d.answer;
    if (e.type === "agent.failed") failed = d.error;
  }
  return { task: String(start.data.task), mode: start.data.mode as "claude" | "replay", lines, answer, failed };
}

export function DemoRun({
  demo,
  agent,
  events,
  onRun,
  onTopUp,
}: {
  demo: DemoStatus;
  agent: Agent;
  events: HubEvent[];
  onRun: (task: string) => Promise<void>;
  onTopUp: () => void;
}) {
  const [task, setTask] = useState(demo.tasks[0] ?? "");
  const [busy, setBusy] = useState(false);
  const run = useMemo(() => consoleLines(events, agent.id), [events, agent.id]);
  const lowFunds = agent.balance < RUN_COST;
  const running = demo.running || busy;

  return (
    <section className="db-card db-run" aria-label="Run the research agent">
      <div className="db-run-head">
        <div>
          <h2 className="db-h2">Run the research agent</h2>
          <p className="muted small">
            It can reach two sellers: <span className="mono">atlas.demo</span> (allowed) and <span className="mono">quickleads.demo</span> (not on its
            list).
          </p>
        </div>
        <span className={`db-pill ${demo.mode === "claude" ? "ok" : ""}`} title={demo.mode === "claude" ? "Each step is decided by Claude" : "Scripted steps, real payments"}>
          {demo.mode === "claude" ? "Powered by Claude" : "Replay mode"}
        </span>
      </div>

      <div className="db-run-tasks" role="radiogroup" aria-label="Task">
        {demo.tasks.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={task === t} className={`db-chip-task ${task === t ? "on" : ""}`} onClick={() => setTask(t)}>
            {t.match(/^[^?.]*[?.]?/)?.[0]}
          </button>
        ))}
      </div>
      {demo.mode === "replay" && (
        <div className="db-run-note small">
          Claude isn't available on this hub right now, so the agent replays a fixed NVIDIA research script with real payments. Your task text is
          ignored until Claude is back.
        </div>
      )}
      <label className="db-field">
        <span>Task</span>
        <textarea value={task} onChange={(e) => setTask(e.target.value)} maxLength={400} rows={2} />
      </label>

      {lowFunds ? (
        <div className="db-run-funds">
          <div>
            <strong>Add money first.</strong> This run spends about {usd(RUN_COST, 2)}; the wallet has {usd(agent.balance, 2)}.
            {demo.sandboxBuyer && (
              <div className="muted small">
                PayPal sandbox login: <span className="mono">{demo.sandboxBuyer.email}</span> / <span className="mono">{demo.sandboxBuyer.password}</span> (test money only)
              </div>
            )}
          </div>
          <button type="button" className="db-btn primary" onClick={onTopUp}>Add $10 with PayPal</button>
        </div>
      ) : (
        <div className="db-setup-actions">
          <button
            type="button"
            className="db-btn primary glow"
            disabled={running || !task.trim()}
            onClick={async () => {
              setBusy(true);
              await onRun(task).finally(() => setBusy(false));
            }}
          >
            {running ? "Agent is working…" : "Run the agent"}
          </button>
        </div>
      )}

      {run && (
        <div className="db-console" aria-live="polite">
          <div className="db-console-task muted small">Task: {run.task}</div>
          <ol>
            {run.lines.map((l) => (
              <li key={l.id} className={`db-line ${l.tone}`}>
                <span className="db-line-mark" aria-hidden="true">{{ say: "◆", call: "→", pay: "$", wait: "…", stop: "✕", ok: "✓", err: "!" }[l.tone]}</span>
                <span>{l.text}</span>
              </li>
            ))}
            {!run.answer && !run.failed && <li className="db-line typing"><span className="db-line-mark">·</span><span>working</span></li>}
          </ol>
          {run.answer && <div className="db-answer">{run.answer}</div>}
          {run.failed && <div className="db-error">The run stopped: {run.failed}</div>}
        </div>
      )}
    </section>
  );
}
