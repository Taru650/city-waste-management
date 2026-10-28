import 'package:flutter/material.dart';

import '../i18n/strings.dart';
import '../models/models.dart';

const statusApi = {
  ComplaintStatus.pending: 'PENDING', ComplaintStatus.assigned: 'ASSIGNED', ComplaintStatus.workInProgress: 'WORK_IN_PROGRESS',
  ComplaintStatus.resolved: 'RESOLVED', ComplaintStatus.rejected: 'REJECTED', ComplaintStatus.duplicate: 'DUPLICATE',
  ComplaintStatus.reopened: 'REOPENED', ComplaintStatus.closed: 'CLOSED',
};

Color statusColor(ComplaintStatus s) => switch (s) {
      ComplaintStatus.pending => Colors.orange,
      ComplaintStatus.assigned => Colors.blue,
      ComplaintStatus.workInProgress => Colors.indigo,
      ComplaintStatus.resolved => Colors.green,
      ComplaintStatus.closed => Colors.grey,
      ComplaintStatus.rejected => Colors.red,
      ComplaintStatus.duplicate => Colors.purple,
      ComplaintStatus.reopened => Colors.deepOrange,
    };

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key});
  final ComplaintStatus status;

  @override
  Widget build(BuildContext context) {
    final c = statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12), border: Border.all(color: c.withValues(alpha: 0.5))),
      child: Text(S.of(context).t('st.${statusApi[status]}'), style: TextStyle(color: c, fontWeight: FontWeight.w600, fontSize: 12)),
    );
  }
}

/// Client-side mirror of the API's basic rule (8–128 characters, letters and digits); the server
/// also refuses common passwords and ones containing the mobile number or email name.
bool passwordProblem(String p) => p.length < 8 || p.length > 128 || !RegExp('[A-Za-z]').hasMatch(p) || !RegExp(r'\d').hasMatch(p);

String fmtDate(DateTime d) {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  String two(int v) => v.toString().padLeft(2, '0');
  return '${d.day} ${m[d.month - 1]} ${d.year}, ${two(d.hour)}:${two(d.minute)}';
}

class ComplaintTile extends StatelessWidget {
  const ComplaintTile(this.c, {super.key, this.onTap});
  final Complaint c;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: ListTile(
        onTap: onTap,
        title: Text(c.typeName(s.lang), style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(c.complaintNo, style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()])),
          Text('${c.ulbName} · ${s.t('ward')} ${c.wardNumber} · ${fmtDate(c.createdAt)}', style: const TextStyle(fontSize: 12)),
          if (c.slaBreached && c.status.isOpen) Text(s.t('overdue'), style: const TextStyle(color: Colors.red, fontSize: 12)),
        ]),
        trailing: StatusChip(c.status),
        isThreeLine: true,
      ),
    );
  }
}

class EventTimeline extends StatelessWidget {
  const EventTimeline(this.events, {super.key});
  final List<ComplaintEvent> events;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Column(
      children: [
        for (final e in events)
          ListTile(
            dense: true,
            leading: Icon(Icons.circle, size: 12, color: e.action == 'SLA_BREACH' || e.action == 'ESCALATE' || e.action == 'REJECT' ? Colors.red : Colors.green),
            title: Text(s.t('ev.${e.action}')),
            subtitle: Text([fmtDate(e.at), if (e.actorName != null) e.actorName!, if (e.remark != null) '“${e.remark}”'].join(' · ')),
          ),
      ],
    );
  }
}

/// Evidence thumbnails per stage; tap to view full size. URLs are short-lived signed URLs.
class MediaStrip extends StatelessWidget {
  const MediaStrip(this.items, {super.key});
  final List<MediaItem> items;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    final groups = {MediaStage.complaint: s.t('before'), MediaStage.workStart: s.t('workStart'), MediaStage.resolution: s.t('after')};
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final g in groups.entries)
          if (items.any((m) => m.stage == g.key)) ...[
            Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 4), child: Text(g.value, style: const TextStyle(fontWeight: FontWeight.w600))),
            SizedBox(
              height: 96,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                children: [
                  for (final m in items.where((m) => m.stage == g.key))
                    Padding(
                      padding: const EdgeInsets.all(4),
                      child: GestureDetector(
                        onTap: m.url == null || m.isVideo ? null : () => showDialog<void>(context: context, builder: (_) => Dialog(child: InteractiveViewer(child: Image.network(m.url!)))),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: m.thumbnailUrl == null
                              ? Container(width: 120, color: Colors.black12, child: const Icon(Icons.hourglass_top))
                              : Stack(alignment: Alignment.center, children: [
                                  Image.network(m.thumbnailUrl!, width: 120, height: 88, fit: BoxFit.cover),
                                  if (m.isVideo) const Icon(Icons.play_circle, color: Colors.white, size: 36),
                                ]),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ],
      ],
    );
  }
}

class ErrorRetry extends StatelessWidget {
  const ErrorRetry(this.error, {super.key, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final s = S.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Icon(Icons.cloud_off, size: 48, color: Colors.grey),
          const SizedBox(height: 8),
          Text('$error'.replaceFirst(RegExp(r'^ApiException\(\d+\): '), ''), textAlign: TextAlign.center),
          const SizedBox(height: 12),
          FilledButton(onPressed: onRetry, child: Text(s.t('retry'))),
        ]),
      ),
    );
  }
}
