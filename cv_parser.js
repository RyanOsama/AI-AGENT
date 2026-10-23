const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * استخراج النص الصافي من ملف السيرة الذاتية (يدعم PDF والنصوص العادية)
 */
async function extractRawTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext === '.pdf') {
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      await parser.destroy().catch(() => {});
    }
  } else if (ext === '.txt' || ext === '.md' || ext === '.json') {
    return fs.readFileSync(filePath, 'utf8');
  } else {
    // محاولة قراءة المحتوى كنص
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      throw new Error(`صيغة الملف ${ext} غير مدعومة مباشرة، يرجى رفع ملف PDF أو TXT.`);
    }
  }
}

/**
 * وكيل استخراج وتدقيق الملف الشخصي (ProfileExtractorAgent)
 * يحلل نص السيرة الذاتية بدقة عالية ويستخرج هيكل Candidate Profile الصارم
 */
async function parseCvToProfile(rawText) {
  if (!rawText || rawText.trim().length < 30) {
    throw new Error('محتوى السيرة الذاتية قصير جداً أو فارغ، تعذر التحليل.');
  }

  const prompt = `
أنت "Profile Extractor Agent" - وكيل ذكاء اصطناعي فائق الدقة متخصص في قراءة وفهرسة السير الذاتية وتحويلها إلى ملف مرشح مهيكل (Candidate Profile).

القاعدة الذهبية الصارمة:
- استخرج فقط البيانات الحقيقية المؤكدة المذكورة نصاً في السيرة الذاتية أدناه.
- ممنوع تماماً اختلاق أو افتراض أي شركة، مهارة، مشروع، تاريخ، شهادة، أو لغة غير مذكورة.
- إذا كان هناك حقل غير متوفر اتركه فارغاً ("") أو مصفوفة فارغة ([]).

نص السيرة الذاتية:
----------------------------------------
${rawText.substring(0, 15000)}
----------------------------------------

المطلوب إخراج النتيجة بتنسيق JSON حصراً بهذا الهيكل الدقيق:
{
  "full_name": "الاسم الكامل للمرشح",
  "headline": "المسمى الوظيفي الرئيسي (مثل: Senior Full Stack Engineer)",
  "email": "البريد الإلكتروني إن وجد",
  "phone": "رقم الهاتف إن وجد",
  "location": "المدينة / الدولة الحالية",
  "links": [
    { "title": "LinkedIn", "url": "الرابط إن وجد" },
    { "title": "GitHub", "url": "الرابط إن وجد" },
    { "title": "Portfolio", "url": "الرابط إن وجد" }
  ],
  "summary": "نبذة مهنية موجزة مستخرجة بدقة من السيرة الذاتية",
  "years_of_experience": 4, // عدد سنوات الخبرة الإجمالية كرقم تقديري محسوب من التواريخ الحقيقية
  "skills": [
    { "category": "لغات البرمجة (Programming Languages)", "items": ["JavaScript", "Python"] },
    { "category": "أطر العمل والمكتبات (Frameworks & Libraries)", "items": ["React", "Node.js"] },
    { "category": "قواعد البيانات (Databases)", "items": ["PostgreSQL", "MongoDB"] },
    { "category": "الأدوات وبيئات التشغيل (Tools & Cloud)", "items": ["Docker", "Git", "AWS"] },
    { "category": "مهارات أخرى (Other Technical / Soft Skills)", "items": ["Agile", "REST APIs"] }
  ],
  "all_skills_flat": ["قائمة مسطحة بكل المهارات والتقنيات الفريدة المستخرجة"],
  "experience": [
    {
      "title": "المسمى الوظيفي في الشركة",
      "company": "اسم الشركة",
      "location": "مقر الشركة أو Remote",
      "start_date": "تاريخ البدء",
      "end_date": "تاريخ الانتهاء أو Present",
      "is_current": false,
      "description": "وصف الدور والمسؤوليات الحقيقية",
      "key_achievements": ["إنجاز 1", "إنجاز 2"],
      "technologies_used": ["التقنيات المذكورة في هذه الوظيفة"]
    }
  ],
  "education": [
    {
      "degree": "الدرجة العلمية والتخصص",
      "institution": "اسم الجامعة أو المؤسسة",
      "graduation_year": "سنة التخرج إن وجدت",
      "details": "أي تفاصيل إضافية مذكورة"
    }
  ],
  "certifications": [
    {
      "name": "اسم الشهادة المعتمدة",
      "issuer": "الجهة المانحة",
      "year": "السنة إن ذكرت"
    }
  ],
  "projects": [
    {
      "title": "اسم المشروع",
      "description": "وصف المشروع",
      "technologies": ["التقنيات المستخدمة في المشروع"],
      "link": "رابط المشروع إن وجد"
    }
  ],
  "languages": [
    {
      "language": "اسم اللغة (مثل: العربية، English)",
      "proficiency": "مستوى الإتقان المذكور (مثل: Native, Fluent, Intermediate)"
    }
  ]
}

ملاحظات:
- أجب بكود JSON صالح فقط دون أي شروحات قبل أو بعد النص.
`;

  const candidateModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-3.6-flash'
  ];
  let lastError = null;

  for (const modelName of candidateModels) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
          config: {
            responseMimeType: 'application/json'
          }
        });

        const rawJson = response.text.trim();
        const parsed = JSON.parse(rawJson);

        // تطهير وهيكلة المخرجات
        return {
          full_name: parsed.full_name || '',
          headline: parsed.headline || '',
          email: parsed.email || '',
          phone: parsed.phone || '',
          location: parsed.location || '',
          links: Array.isArray(parsed.links) ? parsed.links.filter(l => l && l.url) : [],
          summary: parsed.summary || '',
          years_of_experience: typeof parsed.years_of_experience === 'number' ? parsed.years_of_experience : 0,
          skills: Array.isArray(parsed.skills) ? parsed.skills : [],
          all_skills_flat: Array.isArray(parsed.all_skills_flat) ? parsed.all_skills_flat : [],
          experience: Array.isArray(parsed.experience) ? parsed.experience : [],
          education: Array.isArray(parsed.education) ? parsed.education : [],
          certifications: Array.isArray(parsed.certifications) ? parsed.certifications : [],
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
          languages: Array.isArray(parsed.languages) ? parsed.languages : [],
          raw_text: rawText
        };
      } catch (err) {
        lastError = err;
        console.warn(`[ProfileExtractor] فشل مع ${modelName} (محاولة ${attempt}):`, err.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  throw new Error(`فشل استخراج بيانات الـ CV عبر الذكاء الاصطناعي: ${lastError?.message || 'خطأ غير معروف'}`);
}

module.exports = {
  extractRawTextFromFile,
  parseCvToProfile
};
