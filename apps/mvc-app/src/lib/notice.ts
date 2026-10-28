/**
 * Privacy notice under the Digital Personal Data Protection Act, 2023 (section 5): what is collected, why, and how to
 * exercise rights. Changing the text means bumping NOTICE_VERSION: citizens are then asked to accept the new version
 * at their next sign-in.
 *
 * DRAFT for legal review: the wording is a working draft, not legal advice. The ULB/state legal team must approve it
 * (and fill in the grievance officer through GRIEVANCE_OFFICER_* in .env) before any real deployment.
 */
export const NOTICE_VERSION = '2026-10-v1';
export const CONSENT_PURPOSE = 'GRIEVANCE_SERVICE';
export const consentNoticeVersion = () => NOTICE_VERSION;

export interface NoticeSection { heading: string; body: string }

export const NOTICE: Record<'en' | 'hi', { title: string; sections: NoticeSection[] }> = {
  en: {
    title: 'Privacy notice — Swachh Seva',
    sections: [
      { heading: 'Who processes your data', body: 'Your Urban Local Body (Nagar Nigam / Nagar Parishad / Nagar Panchayat) and the State Urban Development Department, as Data Fiduciary, through this application.' },
      { heading: 'What we collect', body: 'Name, optional father/husband name, mobile number, email, home ward; for each complaint: photos and videos taken in the app, GPS location and time of capture, description and landmark; your rating and remark; technical data needed for security (device key, app version, sign-in IP address).' },
      { heading: 'Why', body: 'Only to register, route, resolve and report on cleanliness complaints, to tell you about their progress, and to keep the service secure. Your data is not sold or used for advertising.' },
      { heading: 'Who sees it', body: 'Officials and field staff of the ULB where the complaint is located, within their jurisdiction. Your mobile number and email are not shown to field staff. Photos are stored without hidden metadata.' },
      { heading: 'How long', body: 'While your account is active. When you delete your account, your name and contact details are erased at once; complaints and their photos remain, without your identity, as public service records. Security logs are kept for at least 180 days as required by CERT-In.' },
      { heading: 'Your rights', body: 'In the app (Profile): see and download your data, correct your name or email, and delete your account (this also withdraws your consent). You can also contact the Grievance Officer below. If not satisfied, you may complain to the Data Protection Board of India.' },
    ],
  },
  hi: {
    title: 'गोपनीयता सूचना — स्वच्छ सेवा',
    sections: [
      { heading: 'आपका डेटा कौन संसाधित करता है', body: 'आपका नगरीय निकाय (नगर निगम / नगर परिषद / नगर पंचायत) तथा राज्य नगरीय विकास विभाग, डेटा फिड्यूशियरी के रूप में, इस ऐप के माध्यम से।' },
      { heading: 'हम क्या लेते हैं', body: 'नाम, वैकल्पिक पिता/पति का नाम, मोबाइल नंबर, ईमेल, गृह वार्ड; हर शिकायत के लिए: ऐप में ली गई फ़ोटो/वीडियो, फ़ोटो लेते समय का GPS स्थान और समय, विवरण और पहचान स्थल; आपकी रेटिंग और टिप्पणी; सुरक्षा हेतु तकनीकी जानकारी (डिवाइस कुंजी, ऐप संस्करण, लॉग इन का IP पता)।' },
      { heading: 'क्यों', body: 'केवल सफ़ाई शिकायतें दर्ज करने, सही अधिकारी तक भेजने, निराकरण और रिपोर्ट के लिए, आपको प्रगति बताने के लिए, और सेवा सुरक्षित रखने के लिए। आपका डेटा बेचा नहीं जाता और विज्ञापन में उपयोग नहीं होता।' },
      { heading: 'कौन देखता है', body: 'शिकायत के स्थान वाले निकाय के अधिकारी और सफ़ाई कर्मी, अपने क्षेत्राधिकार में। आपका मोबाइल नंबर और ईमेल सफ़ाई कर्मियों को नहीं दिखाया जाता। फ़ोटो छिपी जानकारी (मेटाडेटा) के बिना रखी जाती हैं।' },
      { heading: 'कितने समय तक', body: 'जब तक आपका खाता सक्रिय है। खाता हटाने पर आपका नाम और संपर्क विवरण तुरंत मिटा दिए जाते हैं; शिकायतें और उनकी फ़ोटो आपकी पहचान के बिना सार्वजनिक सेवा रिकॉर्ड के रूप में रहती हैं। CERT-In के अनुसार सुरक्षा लॉग कम से कम 180 दिन रखे जाते हैं।' },
      { heading: 'आपके अधिकार', body: 'ऐप में (प्रोफ़ाइल): अपना डेटा देखें और डाउनलोड करें, नाम या ईमेल सुधारें, और खाता हटाएँ (इससे आपकी सहमति भी वापस हो जाती है)। आप नीचे दिए शिकायत अधिकारी से भी संपर्क कर सकते हैं। संतुष्ट न होने पर भारतीय डेटा संरक्षण बोर्ड में शिकायत कर सकते हैं।' },
    ],
  },
};
