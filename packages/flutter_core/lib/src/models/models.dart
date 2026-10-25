// Plain models mirroring the API JSON. Parsing is tolerant of extra fields.

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v)?.toLocal() : null;
double _num(Object? v) => v is num ? v.toDouble() : double.tryParse('$v') ?? 0;

enum Role { webAdmin, districtAdmin, subAdmin, supervisor, worker, citizen }

Role roleFrom(String s) => switch (s) {
      'WEB_ADMIN' => Role.webAdmin,
      'DISTRICT_ADMIN' => Role.districtAdmin,
      'SUB_ADMIN' => Role.subAdmin,
      'SUPERVISOR' => Role.supervisor,
      'WORKER' => Role.worker,
      _ => Role.citizen,
    };

class Me {
  Me({required this.id, required this.role, required this.name, required this.mobile, this.email, this.preferredLanguage = 'hi', this.mustChangePassword = false, this.ulbId});

  final String id;
  final Role role;
  final String name;
  final String mobile;
  final String? email;
  final String preferredLanguage;
  final bool mustChangePassword;
  final String? ulbId;

  factory Me.fromJson(Map<String, dynamic> j) => Me(
        id: j['id'] as String,
        role: roleFrom(j['role'] as String),
        name: j['name'] as String,
        mobile: j['mobile'] as String,
        email: j['email'] as String?,
        preferredLanguage: (j['preferredLanguage'] as String?) ?? 'hi',
        mustChangePassword: j['mustChangePassword'] == true,
        ulbId: j['ulbId'] as String?,
      );
}

class NamedItem {
  NamedItem(this.id, this.name, {this.nameHi, this.code, this.number, this.slaHours});
  final String id;
  final String name;
  final String? nameHi;
  final String? code;
  final int? number;
  final int? slaHours;

  String label(String lang) => lang == 'hi' && (nameHi?.isNotEmpty ?? false) ? nameHi! : name;

  factory NamedItem.district(Map<String, dynamic> j) => NamedItem(j['id'], j['name'], nameHi: j['nameHi']);
  factory NamedItem.ulb(Map<String, dynamic> j) => NamedItem(j['id'], j['name'], nameHi: j['nameHi']);
  factory NamedItem.ward(Map<String, dynamic> j) =>
      NamedItem(j['id'], j['name'] != null ? 'Ward ${j['number']} · ${j['name']}' : 'Ward ${j['number']}', number: j['number'] as int?);
  factory NamedItem.type(Map<String, dynamic> j) =>
      NamedItem(j['id'], j['nameEn'], nameHi: j['nameHi'], code: j['code'], slaHours: j['slaHours'] as int?);
}

class LocateResult {
  LocateResult({required this.wardId, required this.wardNumber, required this.ulbId, required this.ulbName, required this.districtId, required this.districtName});
  final String wardId;
  final int wardNumber;
  final String ulbId;
  final String ulbName;
  final String districtId;
  final String districtName;

  factory LocateResult.fromJson(Map<String, dynamic> j) => LocateResult(
        wardId: j['wardId'], wardNumber: j['wardNumber'] as int, ulbId: j['ulbId'], ulbName: j['ulbName'], districtId: j['districtId'], districtName: j['districtName'],
      );
}

enum ComplaintStatus { pending, assigned, workInProgress, resolved, rejected, duplicate, reopened, closed }

ComplaintStatus statusFrom(String s) => switch (s) {
      'PENDING' => ComplaintStatus.pending,
      'ASSIGNED' => ComplaintStatus.assigned,
      'WORK_IN_PROGRESS' => ComplaintStatus.workInProgress,
      'RESOLVED' => ComplaintStatus.resolved,
      'REJECTED' => ComplaintStatus.rejected,
      'DUPLICATE' => ComplaintStatus.duplicate,
      'REOPENED' => ComplaintStatus.reopened,
      _ => ComplaintStatus.closed,
    };

extension ComplaintStatusX on ComplaintStatus {
  bool get isOpen => const [ComplaintStatus.pending, ComplaintStatus.assigned, ComplaintStatus.workInProgress, ComplaintStatus.reopened].contains(this);
}

class ComplaintEvent {
  ComplaintEvent({required this.action, required this.toStatus, required this.at, this.remark, this.actorRole, this.actorName});
  final String action;
  final ComplaintStatus toStatus;
  final DateTime at;
  final String? remark;
  final String? actorRole;
  final String? actorName;

  factory ComplaintEvent.fromJson(Map<String, dynamic> j) => ComplaintEvent(
        action: j['action'], toStatus: statusFrom(j['toStatus']), at: _date(j['at'])!, remark: j['remark'], actorRole: j['actorRole'], actorName: j['actorName'],
      );
}

class Complaint {
  Complaint({
    required this.id, required this.complaintNo, required this.status, required this.description, this.landmark,
    required this.lat, required this.lng, required this.ulbName, required this.wardNumber, required this.typeNameEn, required this.typeNameHi,
    this.supervisorName, this.workerName, this.workerId, required this.slaDueAt, required this.slaBreached, required this.createdAt,
    this.resolvedAt, this.resolutionRemark, this.reopenCount = 0, this.events = const [], this.feedbackCount = 0, this.eventZoneName,
  });

  final String id;
  final String complaintNo;
  final ComplaintStatus status;
  final String description;
  final String? landmark;
  final double lat;
  final double lng;
  final String ulbName;
  final int wardNumber;
  final String typeNameEn;
  final String typeNameHi;
  final String? supervisorName;
  final String? workerName;
  final String? workerId;
  final DateTime slaDueAt;
  final bool slaBreached;
  final DateTime createdAt;
  final DateTime? resolvedAt;
  final String? resolutionRemark;
  final int reopenCount;
  final List<ComplaintEvent> events;
  final int feedbackCount;

  /// Set when the complaint was filed inside an event zone (mela, festival): its own supervisor and deadline.
  final String? eventZoneName;

  String typeName(String lang) => lang == 'hi' ? typeNameHi : typeNameEn;

  /// The citizen may rate a resolution within 7 days, once per resolution.
  bool get canGiveFeedback => status == ComplaintStatus.resolved && resolvedAt != null && DateTime.now().difference(resolvedAt!).inDays < 7;

  factory Complaint.fromJson(Map<String, dynamic> j) {
    final loc = j['location'] as Map<String, dynamic>;
    final type = j['type'] as Map<String, dynamic>;
    return Complaint(
      id: j['id'], complaintNo: j['complaintNo'], status: statusFrom(j['status']), description: j['description'], landmark: j['landmark'],
      lat: _num(loc['lat']), lng: _num(loc['lng']), ulbName: (j['ulb'] as Map)['name'], wardNumber: (j['ward'] as Map)['number'] as int,
      typeNameEn: type['nameEn'], typeNameHi: type['nameHi'],
      supervisorName: (j['supervisor'] as Map?)?['name'], workerName: (j['worker'] as Map?)?['name'], workerId: (j['worker'] as Map?)?['id'],
      slaDueAt: _date(j['slaDueAt'])!, slaBreached: j['slaBreached'] == true, createdAt: _date(j['createdAt'])!,
      resolvedAt: _date(j['resolvedAt']), resolutionRemark: j['resolutionRemark'], reopenCount: (j['reopenCount'] as int?) ?? 0,
      events: ((j['events'] as List?) ?? []).map((e) => ComplaintEvent.fromJson(e as Map<String, dynamic>)).toList(),
      feedbackCount: ((j['feedback'] as List?) ?? []).length,
      eventZoneName: (j['eventZone'] as Map?)?['name'] as String?,
    );
  }
}

enum MediaStage { complaint, workStart, resolution }

class MediaItem {
  MediaItem({required this.id, required this.stage, required this.isVideo, required this.ready, this.url, this.thumbnailUrl, required this.capturedAt, this.outsideGeofence});
  final String id;
  final MediaStage stage;
  final bool isVideo;
  final bool ready;
  final String? url;
  final String? thumbnailUrl;
  final DateTime capturedAt;
  final bool? outsideGeofence;

  factory MediaItem.fromJson(Map<String, dynamic> j) => MediaItem(
        id: j['id'],
        stage: switch (j['stage']) { 'WORK_START' => MediaStage.workStart, 'RESOLUTION' => MediaStage.resolution, _ => MediaStage.complaint },
        isVideo: j['kind'] == 'VIDEO', ready: j['status'] == 'READY', url: j['url'], thumbnailUrl: j['thumbnailUrl'],
        capturedAt: _date(j['capturedAt'])!, outsideGeofence: j['outsideGeofence'] as bool?,
      );
}

class AppNotification {
  AppNotification({required this.id, required this.title, required this.body, this.complaintId, required this.createdAt, this.readAt});
  final String id;
  final String title;
  final String body;
  final String? complaintId;
  final DateTime createdAt;
  final DateTime? readAt;

  factory AppNotification.fromJson(Map<String, dynamic> j) =>
      AppNotification(id: j['id'], title: j['title'], body: j['body'], complaintId: j['complaintId'], createdAt: _date(j['createdAt'])!, readAt: _date(j['readAt']));
}

class Worker {
  Worker(this.id, this.name, this.openTasks, this.areaName);
  final String id;
  final String name;
  final int openTasks;
  final String? areaName;
  factory Worker.fromJson(Map<String, dynamic> j) => Worker(j['id'], j['name'], (j['openTasks'] as int?) ?? 0, j['areaName']);
}

class Paged<T> {
  Paged(this.items, this.total);
  final List<T> items;
  final int total;
}
