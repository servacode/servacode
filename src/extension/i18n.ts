/**
 * ARABIC AND ENGLISH, FROM ONE PLACE.
 *
 * SPEC: §36, §37.
 *
 * Two rules, and the second is the one products get wrong.
 *
 * NOTHING IS HARDCODED IN A COMPONENT. Every owner-facing string is a key here. A single
 * literal in a panel is the one that never gets translated, and it will be the status line.
 *
 * RTL IS LAYOUT, NOT A CSS PROPERTY. Setting `direction: rtl` mirrors text and leaves the
 * furniture where it was: progress bars still fill from the left, chevrons still point the
 * wrong way, and a table of numbers becomes unreadable. Real mirroring means logical
 * properties throughout and a deliberate decision about what must NOT mirror.
 *
 * What must not mirror is technical content. A file path, a git hash, a code block and an
 * agent id are LTR sequences whose meaning depends on order; flipping them produces
 * something that looks like Arabic-language tooling and is simply wrong. So this module
 * distinguishes owner prose from technical content, and the renderer marks each.
 */

export const Language = {
  EN: 'en',
  AR: 'ar',
} as const;
export type Language = (typeof Language)[keyof typeof Language];

export const Direction = {
  LTR: 'ltr',
  RTL: 'rtl',
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export function directionOf(language: Language): Direction {
  return language === Language.AR ? Direction.RTL : Direction.LTR;
}

/**
 * Every owner-facing string in the Control Center.
 *
 * Deliberately flat. A nested structure reads better and makes a missing key a runtime
 * `undefined` two levels down; a flat map lets one test assert that both languages have
 * exactly the same key set, which is what actually keeps a translation honest.
 */
const STRINGS = {
  en: {
    'app.title': 'Serva Code',
    'app.subtitle': 'Your private AI software company',
    'nav.overview': 'Overview',
    'nav.currentWork': 'Current work',
    'nav.ownerActions': 'Your decisions',
    'nav.company': 'Company',
    'nav.product': 'Product',
    'nav.advantage': 'Advantage',
    'nav.decisions': 'Decisions',
    'nav.gates': 'Gates & quality',
    'nav.engineering': 'Engineering',
    'nav.evidence': 'Evidence',
    'nav.risks': 'Risks',
    'nav.history': 'History',
    'nav.recovery': 'Backup & recovery',
    'nav.machine': 'Machine',
    'status.active': 'Active',
    'status.ownerAction': 'Your decision needed',
    'status.blocked': 'Blocked',
    'status.engineering': 'Engineering',
    'status.unqualified': 'Machine not qualified',
    'status.divergence': 'Changed outside Serva',
    'status.recoveryRequired': 'Recovery required',
    'status.notStarted': 'Not started',
    'overview.project': 'Project',
    'overview.profile': 'Profile',
    'overview.nextAction': 'Next',
    'overview.blockers': 'Blocking',
    'overview.staleFacts': 'Expired facts',
    'overview.nothingWaiting': 'Nothing is waiting for you.',
    'owner.why': 'Why Serva cannot decide this',
    'owner.recommendation': 'Serva recommends',
    'owner.because': 'because',
    'owner.chooseOption': 'Choose one',
    'owner.enterValue': 'Your answer',
    'owner.answer': 'Record this decision',
    'owner.confirmTitle': 'Record this decision?',
    'owner.blocksWork': 'This is blocking work',
    'release.status': 'Release readiness',
    'release.ready': 'Ready to release',
    'release.blocked': 'Blocked',
    'release.notVerified': 'Not verified',
    'release.conditionMet': 'Met',
    'release.conditionNotMet': 'Not met',
    'release.conditionNotVerified': 'Not verified',
    'release.conditionNotApplicable': 'Not applicable',
    'machine.qualification': 'Machine qualification',
    'machine.hard': 'HARD — engineering may run',
    'machine.soft': 'SOFT — read-only',
    'machine.unqualified': 'Unqualified',
    'machine.blocked': 'Blocked',
    'machine.notTransferred':
      'Qualification is not carried by a backup. This machine must be measured.',
    'coverage.stages': 'Lifecycle stages',
    'coverage.gates': 'Quality gates',
    'common.refresh': 'Refresh',
    'common.confirm': 'Confirm',
    'common.cancel': 'Cancel',
    'common.none': 'None',
    'common.evidence': 'Evidence',
    'common.reason': 'Reason',
    'error.notAServaProject': 'This folder is not a Serva project.',
    'error.actionRefused': 'Serva refused this',
  },
  ar: {
    'app.title': 'سيرفا كود',
    'app.subtitle': 'شركتك الخاصة لتطوير البرمجيات بالذكاء الاصطناعي',
    'nav.overview': 'نظرة عامة',
    'nav.currentWork': 'العمل الحالي',
    'nav.ownerActions': 'قراراتك',
    'nav.company': 'الشركة',
    'nav.product': 'المنتج',
    'nav.advantage': 'الميزة التنافسية',
    'nav.decisions': 'القرارات',
    'nav.gates': 'البوابات والجودة',
    'nav.engineering': 'الهندسة',
    'nav.evidence': 'الأدلة',
    'nav.risks': 'المخاطر',
    'nav.history': 'السجل',
    'nav.recovery': 'النسخ الاحتياطي والاسترجاع',
    'nav.machine': 'الجهاز',
    'status.active': 'نشِط',
    'status.ownerAction': 'بانتظار قرارك',
    'status.blocked': 'متوقف',
    'status.engineering': 'قيد التنفيذ الهندسي',
    'status.unqualified': 'الجهاز غير مؤهَّل',
    'status.divergence': 'تغييرات خارج سيرفا',
    'status.recoveryRequired': 'يلزم الاسترجاع',
    'status.notStarted': 'لم يبدأ',
    'overview.project': 'المشروع',
    'overview.profile': 'النمط',
    'overview.nextAction': 'التالي',
    'overview.blockers': 'ما يعيق التقدم',
    'overview.staleFacts': 'معلومات انتهت صلاحيتها',
    'overview.nothingWaiting': 'لا شيء ينتظر منك إجراءً.',
    'owner.why': 'لماذا لا يستطيع سيرفا أن يقرر هذا',
    'owner.recommendation': 'توصية سيرفا',
    'owner.because': 'لأن',
    'owner.chooseOption': 'اختر واحداً',
    'owner.enterValue': 'إجابتك',
    'owner.answer': 'تسجيل هذا القرار',
    'owner.confirmTitle': 'هل تريد تسجيل هذا القرار؟',
    'owner.blocksWork': 'هذا يوقف العمل',
    'release.status': 'جاهزية الإصدار',
    'release.ready': 'جاهز للإصدار',
    'release.blocked': 'متوقف',
    'release.notVerified': 'غير مُتحقَّق منه',
    'release.conditionMet': 'مستوفى',
    'release.conditionNotMet': 'غير مستوفى',
    'release.conditionNotVerified': 'غير مُتحقَّق منه',
    'release.conditionNotApplicable': 'لا ينطبق',
    'machine.qualification': 'تأهيل الجهاز',
    'machine.hard': 'مؤهَّل بالكامل — يمكن تشغيل الهندسة',
    'machine.soft': 'قراءة فقط',
    'machine.unqualified': 'غير مؤهَّل',
    'machine.blocked': 'محظور',
    'machine.notTransferred': 'التأهيل لا يُنقل مع النسخة الاحتياطية. يجب قياس هذا الجهاز.',
    'coverage.stages': 'مراحل دورة الحياة',
    'coverage.gates': 'بوابات الجودة',
    'common.refresh': 'تحديث',
    'common.confirm': 'تأكيد',
    'common.cancel': 'إلغاء',
    'common.none': 'لا شيء',
    'common.evidence': 'الدليل',
    'common.reason': 'السبب',
    'error.notAServaProject': 'هذا المجلد ليس مشروع سيرفا.',
    'error.actionRefused': 'رفض سيرفا هذا الإجراء',
  },
} as const;

export type MessageKey = keyof (typeof STRINGS)['en'];

/**
 * Translate.
 *
 * A missing key returns the key itself rather than an empty string, because an empty
 * string looks like a design decision and a visible `nav.overview` looks like the bug it
 * is. The test below makes the case unreachable anyway.
 */
export function t(language: Language, key: MessageKey): string {
  const table = STRINGS[language] as Record<string, string | undefined>;
  return table[key] ?? (STRINGS.en as Record<string, string>)[key] ?? key;
}

/** Every key, for the test that keeps the two languages in step. */
export function messageKeys(language: Language): readonly string[] {
  return Object.keys(STRINGS[language]).sort();
}

/**
 * Content that must NOT mirror, however the interface is laid out.
 *
 * A path, a hash, an id and a code block are ordered sequences whose meaning depends on
 * that order. Mirroring them produces something that looks localised and is wrong — and
 * the reader who most needs them right is the one debugging at the time.
 */
export function isTechnicalContent(value: string): boolean {
  return (
    /^[A-Z]{2,}-[A-Z0-9-]+$/.test(value) ||
    /^[0-9a-f]{7,40}$/.test(value) ||
    /[/\\]/.test(value) ||
    /^\w+\.\w+/.test(value)
  );
}

/**
 * The direction one span of content should render in.
 *
 * Owner prose follows the interface. Technical content is always LTR, inside an interface
 * that may be RTL — which is correct rather than a compromise: a file path is not an
 * Arabic sentence and does not become one by appearing in an Arabic interface.
 */
export function contentDirection(value: string, language: Language): Direction {
  return isTechnicalContent(value) ? Direction.LTR : directionOf(language);
}
