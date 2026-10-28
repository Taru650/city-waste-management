import '../models/models.dart';
import '../security/attestation.dart';
import 'api_client.dart';
import 'api_exception.dart';
import 'token_store.dart';

enum LoginOutcome { ok, mfaRequired }

/// Account endpoints. Tokens are written to the secure store and never returned to the UI.
class AuthRepository {
  AuthRepository(this.api, {this.attestor});
  final ApiClient api;

  /// Play Integrity proof for the public account endpoints (the apps have no CAPTCHA).
  final Attestor? attestor;

  Future<Map<String, String>> _proof(String purpose) async => attestor == null ? const {} : attestor!.prove(purpose);

  Future<LoginOutcome> login(String identifier, String password) async {
    final r = await api.postPublic<Map<String, dynamic>>('/auth/login', {'identifier': identifier, 'password': password});
    if (r['status'] != 'OK') return LoginOutcome.mfaRequired; // administrators use the web portal
    await api.store.write(Tokens(r['accessToken'] as String, r['refreshToken'] as String));
    return LoginOutcome.ok;
  }

  Future<void> registerCitizen({
    required String homeWardId, required String name, String? guardianName, required String mobile, required String email, required String password,
    required String consentNoticeVersion, String consentLanguage = 'hi',
  }) async {
    final proof = await _proof('register');
    final r = await api.postPublic<Map<String, dynamic>>('/auth/register', {
      ...proof,
      'consentNoticeVersion': consentNoticeVersion, 'consentLanguage': consentLanguage,
      'homeWardId': homeWardId, 'name': name, if (guardianName != null && guardianName.isNotEmpty) 'guardianName': guardianName,
      'mobile': mobile, 'email': email, 'password': password,
    });
    await api.store.write(Tokens(r['accessToken'] as String, r['refreshToken'] as String));
  }

  Future<void> forgotPassword(String identifier) async =>
      api.postPublic('/auth/forgot-password', {...await _proof('forgot-password'), 'identifier': identifier});

  Future<Me> me() async => Me.fromJson(await api.get<Map<String, dynamic>>('/auth/me'));

  Future<void> changePassword(String current, String next) async {
    final r = await api.post<Map<String, dynamic>>('/auth/change-password', {'currentPassword': current, 'newPassword': next});
    await api.store.write(Tokens(r['accessToken'] as String, r['refreshToken'] as String));
  }

  Future<void> setLanguage(String lang) => api.patch('/auth/me/preferences', {'preferredLanguage': lang});

  /// Revokes this device's session on the server, then forgets it locally.
  Future<void> logout() async {
    final t = await api.store.read();
    if (t != null) {
      try {
        await api.postPublic('/auth/logout', {'refreshToken': t.refreshToken});
      } on ApiException {
        // offline: still sign out locally
      }
    }
    await api.store.clear();
  }

  Future<bool> hasSession() async => (await api.store.read()) != null;
}

class MastersRepository {
  MastersRepository(this.api);
  final ApiClient api;

  Future<List<NamedItem>> districts() async =>
      (await api.getPublic<List<dynamic>>('/masters/districts')).map((e) => NamedItem.district(e as Map<String, dynamic>)).toList();
  Future<List<NamedItem>> ulbs(String districtId) async =>
      (await api.getPublic<List<dynamic>>('/masters/districts/$districtId/ulbs')).map((e) => NamedItem.ulb(e as Map<String, dynamic>)).toList();
  Future<List<NamedItem>> wards(String ulbId) async =>
      (await api.getPublic<List<dynamic>>('/masters/ulbs/$ulbId/wards')).map((e) => NamedItem.ward(e as Map<String, dynamic>)).toList();
  Future<List<NamedItem>> complaintTypes() async =>
      (await api.getPublic<List<dynamic>>('/masters/complaint-types')).map((e) => NamedItem.type(e as Map<String, dynamic>)).toList();

  /// Ward / ULB / district for a GPS point, or null when no ward boundary covers it.
  Future<LocateResult?> locate(double lat, double lng) async {
    try {
      return LocateResult.fromJson(await api.get<Map<String, dynamic>>('/masters/locate', query: {'lat': lat, 'lng': lng}));
    } on ApiException catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
  }
}

class ComplaintsRepository {
  ComplaintsRepository(this.api);
  final ApiClient api;

  Future<Complaint> create({
    required String typeId, required double lat, required double lng, double? accuracyM, String? wardId,
    String? landmark, required String description, required List<String> mediaIds,
  }) async =>
      Complaint.fromJson(await api.post<Map<String, dynamic>>('/complaints', {
        'typeId': typeId, 'lat': lat, 'lng': lng, 'gpsAccuracyM': ?accuracyM, 'wardId': ?wardId,
        if (landmark != null && landmark.isNotEmpty) 'landmark': landmark, 'description': description, 'mediaIds': mediaIds,
      }));

  Future<Paged<Complaint>> list({String? status, bool open = false, bool overdue = false, int page = 1, int pageSize = 20}) async {
    final r = await api.get<Map<String, dynamic>>('/complaints', query: {
      'status': ?status, if (open) 'open': 'true', if (overdue) 'overdue': 'true', 'page': page, 'pageSize': pageSize,
    });
    return Paged((r['items'] as List).map((e) => Complaint.fromJson(e as Map<String, dynamic>)).toList(), r['total'] as int);
  }

  Future<Complaint> get(String id) async => Complaint.fromJson(await api.get<Map<String, dynamic>>('/complaints/$id'));
  Future<Complaint> track(String complaintNo) async => Complaint.fromJson(await api.get<Map<String, dynamic>>('/complaints/track/${Uri.encodeComponent(complaintNo)}'));
  Future<List<MediaItem>> media(String id) async =>
      (await api.get<List<dynamic>>('/complaints/$id/media')).map((e) => MediaItem.fromJson(e as Map<String, dynamic>)).toList();

  Future<Complaint> feedback(String id, {required int rating, String? remark, bool reopen = false}) async =>
      Complaint.fromJson(await api.post<Map<String, dynamic>>('/complaints/$id/feedback', {
        'rating': rating, if (remark != null && remark.isNotEmpty) 'remark': remark, if (reopen) 'reopen': true,
      }));

  // ---- staff ----
  Future<Complaint> assign(String id, {required String workerId, String? remark}) async =>
      Complaint.fromJson(await api.post<Map<String, dynamic>>('/complaints/$id/assign', {'workerId': workerId, 'remark': ?remark}));

  Future<Complaint> start(String id, {required List<String> mediaIds, double? lat, double? lng, double? accuracyM, String? remark}) async =>
      Complaint.fromJson(await api.post<Map<String, dynamic>>('/complaints/$id/start', {
        'mediaIds': mediaIds, 'remark': ?remark,
        if (lat != null && lng != null) 'location': {'lat': lat, 'lng': lng, 'accuracyM': ?accuracyM},
      }));

  Future<Complaint> resolve(String id, {required String remark, required List<String> mediaIds, double? lat, double? lng, double? accuracyM}) async =>
      Complaint.fromJson(await api.post<Map<String, dynamic>>('/complaints/$id/resolve', {
        'remark': remark, 'mediaIds': mediaIds,
        if (lat != null && lng != null) 'location': {'lat': lat, 'lng': lng, 'accuracyM': ?accuracyM},
      }));

  Future<Complaint> reject(String id, String reason) async =>
      Complaint.fromJson(await api.post<Map<String, dynamic>>('/complaints/$id/reject', {'reason': reason}));
}

class NotificationsRepository {
  NotificationsRepository(this.api);
  final ApiClient api;

  Future<Paged<AppNotification>> list({int page = 1}) async {
    final r = await api.get<Map<String, dynamic>>('/notifications', query: {'page': page, 'pageSize': 30});
    return Paged((r['items'] as List).map((e) => AppNotification.fromJson(e as Map<String, dynamic>)).toList(), r['total'] as int);
  }

  Future<int> unreadCount() async => (await api.get<Map<String, dynamic>>('/notifications/unread-count'))['count'] as int;
  Future<void> markRead(String id) => api.post('/notifications/$id/read');
  Future<void> markAllRead() => api.post('/notifications/read-all');
  Future<void> registerPushToken(String token, String platform) => api.post('/notifications/push-tokens', {'token': token, 'platform': platform});
  Future<void> removePushToken(String token) => api.delete('/notifications/push-tokens', {'token': token});
}

class StaffRepository {
  StaffRepository(this.api);
  final ApiClient api;
  Future<List<Worker>> workers() async => (await api.get<List<dynamic>>('/users/workers')).map((e) => Worker.fromJson(e as Map<String, dynamic>)).toList();
}


/// DPDP Act rights for citizens: notice, consent, access (export), correction, erasure.
class PrivacyRepository {
  PrivacyRepository(this.api);
  final ApiClient api;

  Future<PrivacyNotice> notice(String lang) async => PrivacyNotice.fromJson(await api.getPublic<Map<String, dynamic>>('/privacy/notice'), lang);
  Future<void> consent(String version, String lang) => api.post('/privacy/consent', {'noticeVersion': version, 'language': lang});
  Future<Map<String, dynamic>> myData() => api.get<Map<String, dynamic>>('/privacy/my-data');
  Future<void> correct({String? name, String? email}) => api.patch('/privacy/profile', {'name': ?name, 'email': ?email});

  /// Irreversible. The server ends every session; the caller then clears local state.
  Future<void> erase(String password) => api.post('/privacy/erasure', {'password': password});
}
