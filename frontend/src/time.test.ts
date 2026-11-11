import { afterEach, describe, expect, it } from 'vitest';
import { daysAgo, durationLabel, fromWall, setZone, timeRange, wall, zoneAbbr } from './time';

afterEach(() => setZone('America/Chicago'));

describe('time zones', () => {
  it('reads wall-clock time in the chosen zone', () => {
    const t = new Date('2026-11-10T20:00:00Z');
    expect(wall(t, 'America/Chicago')).toMatchObject({ y: 2026, mo: 11, d: 10, h: 14, mi: 0, weekday: 2 });
    expect(wall(t, 'Asia/Taipei')).toMatchObject({ y: 2026, mo: 11, d: 11, h: 4, mi: 0 });
  });

  it('turns a wall-clock time back into the same instant', () => {
    expect(fromWall({ y: 2026, mo: 11, d: 10, h: 14, mi: 0 }, 'America/Chicago').toISOString()).toBe('2026-11-10T20:00:00.000Z');
    expect(fromWall({ y: 2026, mo: 7, d: 1, h: 9, mi: 30 }, 'America/Chicago').toISOString()).toBe('2026-07-01T14:30:00.000Z');
    expect(fromWall({ y: 2026, mo: 11, d: 11, h: 4, mi: 0 }, 'Asia/Taipei').toISOString()).toBe('2026-11-10T20:00:00.000Z');
    expect(fromWall({ y: 2026, mo: 3, d: 1, h: 0, mi: 0 }, 'Asia/Kolkata').toISOString()).toBe('2026-02-28T18:30:00.000Z');
  });

  it('moves a time skipped by daylight saving forward', () => {
    // 2:30 AM doesn't exist in Chicago on 2026-03-08.
    expect(fromWall({ y: 2026, mo: 3, d: 8, h: 2, mi: 30 }, 'America/Chicago').toISOString()).toBe('2026-03-08T08:30:00.000Z');
  });

  it('keeps the same moment when the zone changes', () => {
    const start = fromWall({ y: 2026, mo: 11, d: 10, h: 9, mi: 0 }, 'America/Chicago');
    setZone('Europe/London');
    expect(wall(start)).toMatchObject({ h: 15, mi: 0 });
    expect(zoneAbbr(start)).toBe('GMT');
  });

  it('counts days in the zone, not the browser', () => {
    setZone('Pacific/Kiritimati');
    expect(daysAgo(Date.now())).toBe(0);
    expect(daysAgo(Date.now() + 3 * 86400000)).toBe(-3);
  });

  it('labels ranges and durations', () => {
    const a = new Date('2026-11-10T20:00:00Z');
    expect(timeRange(a, new Date(a.getTime() + 3600000), 'America/Chicago').replace(/ /g, ' ')).toBe('2:00 – 3:00 PM');
    expect(timeRange(new Date('2026-11-10T17:30:00Z'), new Date('2026-11-10T18:30:00Z'), 'America/Chicago').replace(/ /g, ' ')).toBe('11:30 AM – 12:30 PM');
    expect(durationLabel(90)).toBe('1 hr 30 min');
    expect(durationLabel(45)).toBe('45 min');
    expect(durationLabel(120)).toBe('2 hr');
  });
});

import { parseClock } from './MeetingTime';
describe('typed start times', () => {
  it('reads common ways of writing a time', () => {
    expect(parseClock('2pm', false)).toEqual({ h: 14, mi: 0 });
    expect(parseClock('2:30 PM', false)).toEqual({ h: 14, mi: 30 });
    expect(parseClock('230p', false)).toEqual({ h: 14, mi: 30 });
    expect(parseClock('12am', true)).toEqual({ h: 0, mi: 0 });
    expect(parseClock('14:45', false)).toEqual({ h: 14, mi: 45 });
    expect(parseClock('noon', false)).toEqual({ h: 12, mi: 0 });
    // Without am/pm, keep the half of the day already chosen.
    expect(parseClock('3:15', true)).toEqual({ h: 15, mi: 15 });
    expect(parseClock('9', false)).toEqual({ h: 9, mi: 0 });
    expect(parseClock('25:00', false)).toBeNull();
    expect(parseClock('later', false)).toBeNull();
  });
});
