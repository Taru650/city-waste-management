import { formatComplaintNo } from '../complaints/complaint-number';

export interface NotificationContent {
  type: string;
  title: { en: string; hi: string };
  body: { en: string; hi: string };
}

/**
 * Notification texts. They carry the complaint number and status only — never names,
 * phone numbers, addresses or remarks — because push payloads leave our infrastructure
 * (Google FCM) and appear on lock screens.
 */
export const templates = {
  registered: (no: string): NotificationContent => ({
    type: 'COMPLAINT_REGISTERED',
    title: { en: 'Complaint registered', hi: 'शिकायत दर्ज हुई' },
    body: { en: `Your complaint ${formatComplaintNo(no)} has been registered.`, hi: `आपकी शिकायत ${formatComplaintNo(no)} दर्ज कर ली गई है।` },
  }),
  handedOver: (no: string, zone: string): NotificationContent => ({
    type: 'COMPLAINT_HANDED_OVER',
    title: { en: 'Complaint handed over', hi: 'शिकायत आपको सौंपी गई' },
    body: {
      en: `Event zone "${zone}" has ended. Complaint ${formatComplaintNo(no)} is now with you.`,
      hi: `इवेंट ज़ोन "${zone}" समाप्त हो गया। शिकायत ${formatComplaintNo(no)} अब आपके पास है।`,
    },
  }),
  newInArea: (no: string): NotificationContent => ({
    type: 'COMPLAINT_NEW',
    title: { en: 'New complaint', hi: 'नई शिकायत' },
    body: { en: `Complaint ${formatComplaintNo(no)} needs assignment.`, hi: `शिकायत ${formatComplaintNo(no)} को सौंपना है।` },
  }),
  taskAssigned: (no: string): NotificationContent => ({
    type: 'TASK_ASSIGNED',
    title: { en: 'New task assigned', hi: 'नया कार्य सौंपा गया' },
    body: { en: `Complaint ${formatComplaintNo(no)} is assigned to you.`, hi: `शिकायत ${formatComplaintNo(no)} आपको सौंपी गई है।` },
  }),
  assigned: (no: string): NotificationContent => ({
    type: 'COMPLAINT_ASSIGNED',
    title: { en: 'Field team assigned', hi: 'सफाई दल नियुक्त' },
    body: { en: `A field worker has been assigned to ${formatComplaintNo(no)}.`, hi: `${formatComplaintNo(no)} के लिए सफाई कर्मी नियुक्त किया गया है।` },
  }),
  started: (no: string): NotificationContent => ({
    type: 'WORK_STARTED',
    title: { en: 'Work started', hi: 'कार्य शुरू' },
    body: { en: `Work has started on ${formatComplaintNo(no)}.`, hi: `${formatComplaintNo(no)} पर कार्य शुरू हो गया है।` },
  }),
  resolved: (no: string): NotificationContent => ({
    type: 'COMPLAINT_RESOLVED',
    title: { en: 'Complaint resolved — please rate', hi: 'शिकायत का समाधान — कृपया रेटिंग दें' },
    body: { en: `${formatComplaintNo(no)} is marked resolved. Tell us if you are satisfied.`, hi: `${formatComplaintNo(no)} का समाधान किया गया। क्या आप संतुष्ट हैं?` },
  }),
  rejected: (no: string): NotificationContent => ({
    type: 'COMPLAINT_REJECTED',
    title: { en: 'Complaint not accepted', hi: 'शिकायत स्वीकार नहीं हुई' },
    body: { en: `${formatComplaintNo(no)} was not accepted. Open the app to see the reason.`, hi: `${formatComplaintNo(no)} स्वीकार नहीं की गई। कारण ऐप में देखें।` },
  }),
  duplicate: (no: string): NotificationContent => ({
    type: 'COMPLAINT_DUPLICATE',
    title: { en: 'Merged with an existing complaint', hi: 'पहले से दर्ज शिकायत से जोड़ा गया' },
    body: { en: `${formatComplaintNo(no)} was merged with an earlier complaint for the same spot.`, hi: `${formatComplaintNo(no)} को उसी स्थान की पिछली शिकायत से जोड़ा गया।` },
  }),
  reopened: (no: string): NotificationContent => ({
    type: 'COMPLAINT_REOPENED',
    title: { en: 'Complaint reopened', hi: 'शिकायत फिर से खुली' },
    body: { en: `The citizen is not satisfied with ${formatComplaintNo(no)}.`, hi: `नागरिक ${formatComplaintNo(no)} से संतुष्ट नहीं है।` },
  }),
  closed: (no: string): NotificationContent => ({
    type: 'COMPLAINT_CLOSED',
    title: { en: 'Complaint closed', hi: 'शिकायत बंद' },
    body: { en: `${formatComplaintNo(no)} is closed. Thank you.`, hi: `${formatComplaintNo(no)} बंद कर दी गई है। धन्यवाद।` },
  }),
  slaBreached: (no: string): NotificationContent => ({
    type: 'SLA_BREACHED',
    title: { en: 'Deadline missed', hi: 'समय सीमा पार' },
    body: { en: `${formatComplaintNo(no)} is past its resolution deadline.`, hi: `${formatComplaintNo(no)} की समाधान समय सीमा पार हो गई है।` },
  }),
  escalated: (no: string): NotificationContent => ({
    type: 'ESCALATED',
    title: { en: 'Complaint escalated', hi: 'शिकायत एस्केलेट हुई' },
    body: { en: `${formatComplaintNo(no)} has been escalated to you.`, hi: `${formatComplaintNo(no)} आपको एस्केलेट की गई है।` },
  }),
  mediaRejected: (): NotificationContent => ({
    type: 'MEDIA_REJECTED',
    title: { en: 'Video could not be used', hi: 'वीडियो उपयोग नहीं हो सका' },
    body: { en: 'One of your videos was rejected. Open the app for details.', hi: 'आपका एक वीडियो अस्वीकार हुआ। विवरण ऐप में देखें।' },
  }),
};
