// src/api/routes/strategy.ts
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getClient } from '../../services/client-manager';
import { MNQDeltaTrendTrader } from '../../strategies/mnq-delta-trend/trader';
import { MNQDeltaTrendCalculator } from '../../strategies/mnq-delta-trend/calculator';
import { MNQ_DELTA_TREND_CONFIG } from '../../strategies/mnq-delta-trend/config';
import { Logger } from '../../utils/logger';

const router = Router();
const logger = new Logger('StrategyRoute');

// Helper → compute config hash (ETag/version)
const configHash = (obj: any) =>
  crypto.createHash('md5').update(JSON.stringify(obj ?? {})).digest('hex');

// Keep single strategy instance
let strategy: MNQDeltaTrendTrader | null = null;

// ---------- CONFIG ENDPOINTS ----------
router.get('/config', async (_req: Request, res: Response) => {
  try {
    const version = configHash(MNQ_DELTA_TREND_CONFIG);
    res.setHeader('ETag', version);
    res.json({
      version,
      effective: MNQ_DELTA_TREND_CONFIG,
      appliedAt: new Date().toISOString()
    });
  } catch (err: any) {
    logger.error('GET /config failed', err);
    res.status(500).json({ error: err?.message ?? 'config fetch failed' });
  }
});

router.put('/config', async (req: Request, res: Response) => {
  try {
    const clientETag = req.headers['if-match'] as string | undefined;
    const currentHash = configHash(MNQ_DELTA_TREND_CONFIG);
    if (clientETag && clientETag !== currentHash) {
      return res.status(412).json({
        message: 'Config version mismatch, please refetch first.'
      });
    }

    // Accept only whitelisted keys (16 baseline + breakoutLookbackBars)
    const allowedKeys = [
      'tradingStartTime',
      'tradingEndTime',
      'contractQuantity',

      // Delta
      'deltaSMALength',
      'deltaSpikeThreshold',
      'deltaSurgeMultiplier',
      'breakoutLookbackBars',
      'deltaSlopeExitLength',      // ← add

      // EMA / HTF
      'emaLength',
      'useEmaFilter',
      'htfEMALength',
      'higherTimeframe',
      'htfUseForming',

      // ATR & Exit
      'atrProfitMultiplier',       // ← add
      'atrStopLossMultiplier',
      'minAtrToTrade',
      'minBarsBeforeExit',         // ← add

      // Trailing
      'useTrailingStop',           // ← add
      'trailActivationATR',
      'trailOffsetATR'
    ];

    const body = req.body ?? {};
    for (const k of Object.keys(body)) {
      if (!allowedKeys.includes(k)) delete body[k];
    }

    // Apply changes live
    Object.assign(MNQ_DELTA_TREND_CONFIG, body);

    const newVersion = configHash(MNQ_DELTA_TREND_CONFIG);
    res.setHeader('ETag', newVersion);
    res.json({
      version: newVersion,
      effective: MNQ_DELTA_TREND_CONFIG,
      appliedAt: new Date().toISOString()
    });

    logger.info('[Config][updated]', body);
  } catch (err: any) {
    logger.error('PUT /config failed', err);
    res.status(500).json({ error: err?.message ?? 'config update failed' });
  }
});

// ---------- STRATEGY CONTROL ----------
function normalizeBars(raw: any[]): any[] {
  const toIso = (t: any): string => {
    if (t == null) return '';
    if (typeof t === 'number') return new Date(t).toISOString();
    if (/^\d+$/.test(String(t))) return new Date(Number(t)).toISOString();
    const d = new Date(t);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  };
  const num = (x: any): number => {
    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
  };
  return (raw ?? [])
    .map((r: any) => {
      const ts =
        r.timestamp ??
        r.timestampUtc ??
        r.time ??
        r.barTime ??
        r.startTime ??
        r.date ??
        r.t;
      const o = r.open ?? r.o ?? r.openPrice ?? r.op;
      const h = r.high ?? r.h ?? r.highPrice ?? r.hi;
      const l = r.low ?? r.l ?? r.lowPrice ?? r.lo;
      const c = r.close ?? r.c ?? r.closePrice ?? r.cl;
      const v = r.volume ?? r.v ?? r.vol ?? r.tradeVolume;
      return {
        timestamp: toIso(ts),
        open: num(o),
        high: num(h),
        low: num(l),
        close: num(c),
        volume: Math.max(0, Math.floor(num(v)))
      };
    })
    .filter(
      (b) =>
        b.timestamp &&
        Number.isFinite(b.open) &&
        Number.isFinite(b.high) &&
        Number.isFinite(b.low) &&
        Number.isFinite(b.close)
    );
}

function attachSignedDeltaSeries(bars: any[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < bars.length; i++) {
    const prev = out[i - 1];
    const cur = { ...bars[i] };
    if (i === 0) cur.delta = 0;
    else {
      if (cur.close > prev.close) cur.delta = Math.trunc(cur.volume ?? 0);
      else if (cur.close < prev.close) cur.delta = -Math.trunc(cur.volume ?? 0);
      else cur.delta = 0;
    }
    out.push(cur);
  }
  return out;
}

router.post('/start', async (req: Request, res: Response) => {
  try {
    if (strategy) {
      return res.status(200).json({ success: true, message: 'Strategy already running' });
    }

    const client = getClient();
    if (!client) return res.status(500).json({ success: false, message: 'Client not initialized' });

    const uiAccountIdRaw = (req.body && (req.body as any).accountId) ?? undefined;
    if (uiAccountIdRaw !== undefined && uiAccountIdRaw !== null && uiAccountIdRaw !== '') {
      const parsed = Number(uiAccountIdRaw);
      if (Number.isFinite(parsed)) (client as any).setSelectedAccountId?.(parsed);
    }

    const selectedId = (client as any).getSelectedAccountId?.() ?? null;
    const accounts = await client.getAccounts();
    const resolved = accounts.find((a: any) => a.id === selectedId || a.accountNumber === selectedId);
    console.info('[account@start]', { selectedId, resolved });

    const contracts = await client.searchContracts('MNQ');
    if (!contracts || contracts.length === 0) {
      return res.status(404).json({ success: false, message: 'No MNQ contracts found' });
    }
    const active = contracts.find((c: any) => c.isActive) ?? contracts[0];
    const contractId = active.id;
    const symbol = active.symbolId ?? 'F.US.MNQ';

    const calculator = new MNQDeltaTrendCalculator(MNQ_DELTA_TREND_CONFIG);

    const bars3mRaw = await client.getBars(contractId, '3', 300);
    const htfMinutes = String(MNQ_DELTA_TREND_CONFIG.higherTimeframe ?? 15);
    const barsHTFRaw = await client.getBars(contractId, htfMinutes, 300);

    const bars3m = attachSignedDeltaSeries(normalizeBars(bars3mRaw).sort((a,b)=>new Date(a.timestamp).getTime()-new Date(b.timestamp).getTime()));
    const barsHTF = attachSignedDeltaSeries(normalizeBars(barsHTFRaw).sort((a,b)=>new Date(a.timestamp).getTime()-new Date(b.timestamp).getTime()));

    for (const b of bars3m) calculator.processWarmUpBar(b, '3min');
    for (const b of barsHTF) calculator.processWarmUpBar(b, 'HTF');
    calculator.completeWarmUp();

    strategy = new MNQDeltaTrendTrader({
      client,
      calculator,
      config: MNQ_DELTA_TREND_CONFIG,
      contractId,
      symbol
    });

    await strategy.start();
    logger.info(`Strategy started for ${symbol} (contractId=${contractId})`);
    res.status(200).json({ success: true, message: 'Strategy started', contractId, symbol });
  } catch (err: any) {
    logger.error('Failed to start strategy', err);
    res.status(500).json({ success: false, message: err?.message ?? String(err) });
  }
});

router.post('/stop', async (_req: Request, res: Response) => {
  try {
    if (!strategy) return res.status(200).json({ success: true, message: 'Strategy already stopped' });
    if ((strategy as any).stop) await (strategy as any).stop();
    strategy = null;
    res.status(200).json({ success: true, message: 'Strategy stopped' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message ?? String(err) });
  }
});

router.get('/status', (_req: Request, res: Response) => {
  res.status(200).json({ running: !!strategy });
});

export default router;
