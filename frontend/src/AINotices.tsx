import { useEffect, useRef } from 'react';
import { api } from './api';
import { AINotice, noticeText } from './aiOrder';
import { useToast } from './ui';

type NoticeJobs = { jobs: { id: string; meeting_title: string | null; notices: AINotice[] }[] };

/** Pops up, from any page, when AI notes switch to the next model in the order, or when none of them work. */
export default function AINotices() {
  const toast = useToast();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.hidden) return;
      try {
        const r = await api<NoticeJobs>('/ai/notices');
        if (stopped) return;
        const first = seen.current === null;
        const known = (seen.current ||= new Set());
        for (const j of r.jobs)
          for (const n of j.notices) {
            const key = `${j.id}|${n.at}|${n.reason}|${n.to_label}`;
            if (known.has(key)) continue;
            known.add(key);
            // Notices from before this page loaded were already seen (or are stale).
            if (first) continue;
            const text = noticeText(n, j.meeting_title);
            if (text) toast(text, n.exhausted ? 'error' : 'info');
          }
      } catch {}
    };
    void check();
    const timer = setInterval(check, 4000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [toast]);
  return null;
}
