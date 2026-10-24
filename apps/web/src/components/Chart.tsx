'use client';

import dynamic from 'next/dynamic';
import type { EChartsOption } from 'echarts';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false, loading: () => <div style={{ height: 300 }} /> });

export function Chart({ option, height = 300, testId }: { option: EChartsOption; height?: number; testId?: string }) {
  return (
    <div data-testid={testId}>
      <ReactECharts option={option} style={{ height }} notMerge opts={{ renderer: 'svg' }} />
    </div>
  );
}
