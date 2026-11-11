import { useMemo } from 'react';
import { Globe } from 'lucide-react';
import { Select, type Option } from './ui';
import { allZones, DEFAULT_ZONE, deviceZone, fmt, offsetLabel, offsetMinutes, zoneAbbr, zoneLong } from './time';

/** "America/Argentina/Buenos_Aires" → "Buenos Aires". */
const city = (tz: string) => tz.split('/').pop()!.replace(/_/g, ' ');
const region = (tz: string) => (tz.includes('/') ? tz.split('/')[0] : 'Other');

/** Settings → Notes & navigation → Time zone. */
export function TimeZonePanel({ value, onChange }: { value: string | undefined; onChange: (tz: string) => void }) {
  const zone = value || DEFAULT_ZONE;
  const here = deviceZone();
  const options = useMemo(() => {
    const now = Date.now();
    const list = allZones();
    if (!list.includes(zone)) list.push(zone);
    return list
      .map(tz => ({ tz, off: offsetMinutes(now, tz) }))
      .sort((a, b) => a.off - b.off || a.tz.localeCompare(b.tz))
      .map(
        ({ tz }): Option => ({
          value: tz,
          label: tz === 'UTC' ? 'UTC' : city(tz),
          description: `${tz === 'UTC' ? 'Coordinated Universal Time' : region(tz)} · ${offsetLabel(tz, now)}`,
          keywords: `${tz} ${zoneAbbr(now, tz)} ${zoneLong(now, tz)} ${offsetLabel(tz, now)}${tz === 'America/Chicago' ? ' houston dallas austin texas' : ''}`,
        }),
      );
  }, [zone]);

  return (
    <section className="panel" data-setting="notes-timezone">
      <div className="panel-head">
        <div>
          <h2>Time zone</h2>
          <p className="muted">Meeting dates and times are shown and picked in this zone. Changing it keeps every meeting at the same moment, so its clock time moves with the zone.</p>
        </div>
      </div>
      <div className="setting-line">
        <div>
          <strong>
            {zoneLong(Date.now(), zone)} ({zoneAbbr(Date.now(), zone)})
          </strong>
          <p className="hint">
            It’s {fmt(Date.now(), { weekday: 'short', hour: 'numeric', minute: '2-digit' }, zone)} there now.
            {here !== zone && <> This device is set to {city(here)} ({zoneAbbr(Date.now(), here)}).</>}
          </p>
        </div>
        <div className="tz-line">
          {here !== zone && (
            <button type="button" className="ghost sm" onClick={() => onChange(here)}>
              <Globe size={14} /> Use {city(here)}
            </button>
          )}
          <Select
            ariaLabel="Time zone"
            value={zone}
            options={options}
            onChange={onChange}
            searchable
            searchPlaceholder="Search city, region or abbreviation…"
            minWidth={300}
            placement="bottom-end"
          />
        </div>
      </div>
    </section>
  );
}
