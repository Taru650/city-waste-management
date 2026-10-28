'use client';

import { DatePicker, Select } from 'antd';
import dayjs, { Dayjs } from 'dayjs';
import { useApi } from '@/views/lib/api';
import { Me } from '@/views/lib/session';

export interface Filters {
  from?: string;
  to?: string;
  districtId?: string;
  ulbId?: string;
  wardId?: string;
  typeId?: string;
  eventZoneId?: string;
}

interface Option {
  id: string;
  name?: string;
  number?: number;
  nameEn?: string;
}

/** Cascading jurisdiction filters; fixed levels follow the user's own jurisdiction. */
/**
 * `effectiveRange` is the window the API actually used (IST). It is shown when no dates were
 * chosen, so the picker never disagrees with the figures because of the browser's time zone.
 */
export function FilterBar({ me, value, onChange, dates = true, effectiveRange }: {
  me: Me; value: Filters; onChange: (f: Filters) => void; dates?: boolean; effectiveRange?: { from: string; to: string };
}) {
  const districtId = me.districtId ?? value.districtId;
  const ulbId = me.ulbId ?? value.ulbId;
  const { data: districts } = useApi<Option[]>(me.role === 'WEB_ADMIN' ? '/masters/districts' : null);
  const { data: ulbs } = useApi<Option[]>(districtId && !me.ulbId ? `/masters/districts/${districtId}/ulbs` : null);
  const { data: wards } = useApi<Option[]>(ulbId ? `/masters/ulbs/${ulbId}/wards` : null);
  const { data: types } = useApi<Option[]>('/masters/complaint-types');
  const { data: zones } = useApi<Option[]>('/event-zones');
  const set = (patch: Filters) => onChange({ ...value, ...patch });

  return (
    <div className="filter-bar no-print" role="group" aria-label="Filters">
      {dates && (
        <DatePicker.RangePicker
          allowClear={false}
          value={[
            dayjs(value.from ?? effectiveRange?.from ?? dayjs().subtract(29, 'day').format('YYYY-MM-DD')),
            dayjs(value.to ?? effectiveRange?.to ?? dayjs().format('YYYY-MM-DD')),
          ]}
          disabledDate={(d: Dayjs) => d.isAfter(dayjs(), 'day')}
          presets={[
            { label: 'Last 7 days', value: [dayjs().subtract(6, 'day'), dayjs()] },
            { label: 'Last 30 days', value: [dayjs().subtract(29, 'day'), dayjs()] },
            { label: 'This month', value: [dayjs().startOf('month'), dayjs()] },
            { label: 'Last 90 days', value: [dayjs().subtract(89, 'day'), dayjs()] },
          ]}
          onChange={(r) => r && set({ from: r[0]!.format('YYYY-MM-DD'), to: r[1]!.format('YYYY-MM-DD') })}
          aria-label="Date range"
        />
      )}
      {me.role === 'WEB_ADMIN' && (
        <Select allowClear placeholder="All districts" aria-label="District filter" style={{ width: 180 }} value={value.districtId}
          options={districts?.map((d) => ({ value: d.id, label: d.name }))}
          onChange={(v) => set({ districtId: v, ulbId: undefined, wardId: undefined })} />
      )}
      {!me.ulbId && (
        <Select allowClear placeholder="All ULBs" aria-label="ULB filter" style={{ width: 200 }} value={value.ulbId} disabled={!districtId}
          options={ulbs?.map((u) => ({ value: u.id, label: u.name }))}
          onChange={(v) => set({ ulbId: v, wardId: undefined })} />
      )}
      <Select allowClear placeholder="All wards" aria-label="Ward filter" style={{ width: 160 }} value={value.wardId} disabled={!ulbId}
        options={wards?.map((w) => ({ value: w.id, label: `Ward ${w.number}${w.name ? ` · ${w.name}` : ''}` }))}
        onChange={(v) => set({ wardId: v })} />
      <Select allowClear placeholder="All complaint types" aria-label="Complaint type filter" style={{ width: 210 }} value={value.typeId}
        options={types?.map((t) => ({ value: t.id, label: t.nameEn }))}
        onChange={(v) => set({ typeId: v })} />
      {!!zones?.length && (
        <Select allowClear placeholder="All locations" aria-label="Event zone filter" style={{ width: 200 }} value={value.eventZoneId}
          options={zones.map((z) => ({ value: z.id, label: `Event: ${z.name}` }))}
          onChange={(v) => set({ eventZoneId: v })} />
      )}
    </div>
  );
}
