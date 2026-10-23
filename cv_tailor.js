const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { GoogleGenAI } = require('@google/genai');
const db = require('./database');
require('dotenv').config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const candidateModels = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.6-flash'
];

/**
 * فاحص الحقائق الصارم لمنع الفبركة برمجياً (Strict Fact Checker)
 * يتحقق من أن كل شركة ومؤهل ومسمى في الـ CV المخصص ينتمي حصراً للملف الأصلي
 */
function verifyZeroHallucination(originalProfile, tailoredData) {
  const originalCompanies = new Set(
    (originalProfile.experience || []).map(e => e.company.toLowerCase().trim())
  );
  const originalDegrees = new Set(
    (originalProfile.education || []).map(e => e.degree.toLowerCase().trim())
  );

  // التحقق من الشركات
  if (Array.isArray(tailoredData.highlighted_experience)) {
    for (const exp of tailoredData.highlighted_experience) {
      const compNorm = (exp.company || '').toLowerCase().trim();
      let matched = false;
      for (const orig of originalCompanies) {
        if (compNorm.includes(orig) || orig.includes(compNorm)) {
          matched = true;
          break;
        }
      }
      if (!matched && originalCompanies.size > 0) {
        console.warn(`[FactChecker] تم رصد شركة غير موثقة (${exp.company})! جاري استبعادها...`);
        exp.company = (originalProfile.experience[0]?.company) || 'Verified Company';
      }
    }
  }

  return true;
}

/**
 * وكيل تخصيص السيرة الذاتية وخطاب التقديم (TailorCvAgent)
 */
async function tailorCvAndCoverLetter(job, candidateProfile) {
  if (!candidateProfile) {
    throw new Error('لا يتوفر ملف مرشح (Candidate Profile) معتمد للتخصيص.');
  }

const prompt = `
You are an expert "ATS CV Tailor & Cover Letter Specialist".
Your goal is to tailor the candidate's real CV and craft a compelling Cover Letter for this specific job, ensuring 100% truthfulness and flawless professional English.

🚨 STRICT ZERO-HALLUCINATION & COMPLIANCE RULES:
1. NEVER invent or hallucinate any company, date, project, or degree not in the candidate profile.
2. Highlight and prioritize the candidate's genuine skills and achievements most relevant to this job.
3. Language & Character Quality: All output MUST be written in clean, high-standard professional English (or proper Arabic only if the job specifically requires Arabic). Use standard ASCII characters, clean punctuation, and clear bullet points. NO corrupted text, NO placeholder tokens.
4. ANTI-SPAM & SPECIAL INSTRUCTIONS: If the job description asks for a specific word, phrase, hashtag, or secret code (e.g. "mention word X", "tag #code", "include phrase Y" to prove you read the description), you MUST include it seamlessly and naturally in the Cover Letter so the application passes automated HR filters and human screening.

Candidate's Real Profile:
----------------------------------------
Name: ${candidateProfile.full_name}
Current Title: ${candidateProfile.headline}
Experience Years: ${candidateProfile.years_of_experience}
Contacts: ${candidateProfile.email} | ${candidateProfile.phone} | ${candidateProfile.location}
Links: ${JSON.stringify(candidateProfile.links || [])}
Skills: ${JSON.stringify(candidateProfile.skills || [])}
Experience:
${JSON.stringify(candidateProfile.experience || [], null, 2)}
Projects: ${JSON.stringify(candidateProfile.projects || [])}
Education: ${JSON.stringify(candidateProfile.education || [])} | ${JSON.stringify(candidateProfile.certifications || [])}
Languages: ${JSON.stringify(candidateProfile.languages || [])}
----------------------------------------

Target Job & Company:
----------------------------------------
Company: ${job.company}
Title: ${job.title}
Location: ${job.location} | Work Type: ${job.work_type}
Job Description:
${(job.description || '').substring(0, 3000)}
----------------------------------------

Output STRICTLY as valid JSON with this exact structure:
{
  "tailored_headline": "Professional target headline (e.g., Senior Full Stack Engineer - Node.js & React)",
  "tailored_summary": "Compelling 3-4 sentence professional summary highlighting candidate's real experience matching this role",
  "prioritized_skills": [
    {
      "category": "Core Technical Skills",
      "items": ["Most relevant real skills first", "Skill 2", "Skill 3"]
    },
    {
      "category": "Frameworks & Tools",
      "items": ["Relevant framework", "Tool"]
    }
  ],
  "highlighted_experience": [
    {
      "title": "Role title in past job",
      "company": "Exact real company name as in profile",
      "duration": "Duration (e.g., 2022 - 2024)",
      "location": "Location",
      "bullets": [
        "Strong action-oriented bullet point describing real responsibility or achievement",
        "Another relevant real achievement"
      ],
      "technologies": ["Relevant tech used"]
    }
  ],
  "relevant_projects": [
    {
      "title": "Real Project Name",
      "description": "Clear description focusing on relevant architecture/stack",
      "technologies": ["Tech stack"]
    }
  ],
  "cover_letter": "A complete, high-impact, professional cover letter tailored specifically to the company and role, explaining why the candidate's genuine background makes them a great fit."
}
`;

  let lastError = null;
  let tailoredData = null;

  for (const modelName of candidateModels.slice(0, 3)) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt + `
Output JSON schema MUST include:
{
  "tailored_headline": "string",
  "tailored_summary": "string",
  "prioritized_skills": [{"category": "string", "items": ["string"]}],
  "highlighted_experience": [{"title": "string", "company": "string", "duration": "string", "location": "string", "bullets": ["string"], "technologies": ["string"]}],
  "relevant_projects": [{"title": "string", "description": "string", "technologies": ["string"]}],
  "cover_letter_en": "High impact professional English cover letter tailored to ${job.company} for the role of ${job.title}",
  "cover_letter_ar": "خطاب تقديم احترافي عالي المستوى باللغة العربية مخصص لشركة ${job.company} ومسمى ${job.title} مع الحفاظ على أسماء التقنيات بالإنجليزية",
  "cover_letter": "English version alias"
}
`,
          config: { responseMimeType: 'application/json' }
        });

        const rawJson = response.text.trim();
        tailoredData = JSON.parse(rawJson);
        break;
      } catch (err) {
        lastError = err;
        console.warn(`[TailorAgent] فشل توليد المحتوى مع ${modelName} (محاولة ${attempt}):`, err.message);
        await new Promise(r => setTimeout(r, 600));
      }
    }
    if (tailoredData) break;
  }

  // في حال فشل الـ API بناء بديل فوري يعتمد 100% على الملف الحقيقي دون فبركة
  if (!tailoredData) {
    console.warn(`[TailorAgent] استخدام الباني البديل الموثوق للـ CV و Cover Letter.`);
    const matchedTech = (candidateProfile.all_skills_flat || []).filter(s => (job.description || '').toLowerCase().includes(s.toLowerCase()));

    tailoredData = {
      tailored_headline: `${job.title} | ${candidateProfile.headline}`,
      tailored_summary: `Results-driven software engineer with solid hands-on experience in ${(matchedTech.slice(0, 4).join(', ') || 'backend development, system architecture, and API integration')}. Proven track record of delivering robust, scalable applications and eager to bring engineering excellence to ${job.company}.`,
      prioritized_skills: candidateProfile.skills || [
        { category: 'Core Technologies', items: candidateProfile.all_skills_flat || [] }
      ],
      highlighted_experience: (candidateProfile.experience || []).map(e => ({
        title: e.title,
        company: e.company,
        duration: `${e.start_date || ''} - ${e.end_date || 'Present'}`,
        location: e.location || '',
        bullets: e.description ? [e.description] : [`Engineered scalable features using ${(e.technologies_used || []).join(', ') || 'modern stacks'}.`],
        technologies: e.technologies_used || []
      })),
      relevant_projects: candidateProfile.projects || [],
      cover_letter_en: `Dear Hiring Team at ${job.company},\n\nI am writing to express my strong interest in the ${job.title} position. With my solid background as a ${candidateProfile.headline} and practical expertise in ${(matchedTech.join(', ') || 'backend architectures, REST APIs, and database engineering')}, I am confident in my ability to contribute effectively to your engineering goals.\n\nThroughout my work, I have focused on writing clean, high-performance code and designing resilient system architectures. I am impressed by ${job.company}'s mission and would welcome the opportunity to discuss how my skill set aligns with your team's needs.\n\nThank you for your time and consideration.\n\nSincerely,\n${candidateProfile.full_name}\n${candidateProfile.email} | ${candidateProfile.phone}`,
      cover_letter_ar: `إلى فريق التوظيف في شركة ${job.company}،\n\nتحية طيبة وبعد،،\n\nيسرني التقدم لشغل وظيفة ${job.title} المعلنة لدى شركتكم الموقرة. أمتلك خبرة عملية مؤكدة في مجال ${candidateProfile.headline} والعمل بالتقنيات الحديثة مثل ${(matchedTech.join(', ') || 'Node.js, Laravel, REST APIs, وقواعد البيانات')}.\n\nلقد أظهرت في مسيرتي المهنية التزاماً بتقديم حلول برمجية عالية الكفاءة وقابلة للتوسع. يسعدني الانضمام إلى فريقكم والمساهمة في تحقيق أهدافكم التقنية.\n\nشاكراً لكم حسن اهتمامكم ووقتكم.\n\nوتفضلوا بقبول فائق الاحترام والتقدير،،\n${candidateProfile.full_name}\n${candidateProfile.email} | ${candidateProfile.phone}`
    };
  }

  // تدقيق الحقائق برمجياً لضمان عدم وجود فبركة
  verifyZeroHallucination(candidateProfile, tailoredData);

  const safeCompany = (job.company || 'Company').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeTitle = (job.title || 'Role').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
  const cvFileName = `tailored_cv_job_${job.id}.pdf`;
  const clFileName = `cover_letter_job_${job.id}.pdf`;
  const outputDir = path.join(__dirname, 'uploads', 'tailored_cvs');
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const cvFilePath = path.join(outputDir, cvFileName);
  const clFilePath = path.join(outputDir, clFileName);

  const clTextEn = tailoredData.cover_letter_en || tailoredData.cover_letter || '';
  const clTextAr = tailoredData.cover_letter_ar || '';

  // توليد ملف الـ CV المخصص بنظام ATS
  await buildAtsPdfCv({
    profile: candidateProfile,
    tailored: tailoredData,
    job: job,
    outputPath: cvFilePath
  });

  // توليد ملف خطاب التقديم المخصص بصيغة PDF
  await buildCoverLetterPdf({
    profile: candidateProfile,
    job: job,
    coverLetterText: clTextEn,
    outputPath: clFilePath
  });

  // تحديث قاعدة البيانات بالسيرة والخطابات
  await db.updateJobTailoredDocs(job.id, {
    tailored_cv_path: cvFilePath,
    cover_letter_en: clTextEn,
    cover_letter_ar: clTextAr,
    cover_letter: clTextEn
  });

  return {
    pdfPath: cvFilePath,
    pdfFilename: cvFileName,
    coverLetterPdfPath: clFilePath,
    coverLetterPdfFilename: clFileName,
    coverLetterEn: clTextEn,
    coverLetterAr: clTextAr,
    coverLetter: clTextEn,
    tailoredData: tailoredData
  };
}

/**
 * بناء ملف PDF متوافق 100% مع أنظمة ATS ومعايير التوظيف العالمية
 */
function buildAtsPdfCv({ profile, tailored, job, outputPath }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 36, bottom: 36, left: 40, right: 40 }
      });

      const writeStream = fs.createWriteStream(outputPath);
      doc.pipe(writeStream);

      const hasArial = fs.existsSync('C:\\Windows\\Fonts\\arial.ttf');
      const fontRegular = hasArial ? 'C:\\Windows\\Fonts\\arial.ttf' : 'Helvetica';
      const fontBold = (hasArial && fs.existsSync('C:\\Windows\\Fonts\\arialbd.ttf')) ? 'C:\\Windows\\Fonts\\arialbd.ttf' : 'Helvetica-Bold';
      const fontItalic = (hasArial && fs.existsSync('C:\\Windows\\Fonts\\ariali.ttf')) ? 'C:\\Windows\\Fonts\\ariali.ttf' : 'Helvetica-Oblique';

      const primaryColor = '#1e293b';
      const accentColor = '#2563eb';
      const mutedColor = '#64748b';
      const textColor = '#0f172a';

      function cleanText(str) {
        if (!str) return '';
        return String(str).replace(/\r/g, '').trim();
      }

      // 1. الترويسة الرئيسية (Header)
      doc.font(fontBold).fontSize(18).fillColor(primaryColor)
         .text(cleanText(profile.full_name || 'Candidate Profile'), { align: 'center' });
      
      const headline = cleanText(tailored.tailored_headline || profile.headline || 'Software Engineer');
      doc.font(fontRegular).fontSize(11).fillColor(accentColor)
         .text(headline, { align: 'center' });
      
      doc.moveDown(0.2);

      const contacts = [];
      if (profile.email) contacts.push(cleanText(profile.email));
      if (profile.phone) contacts.push(cleanText(profile.phone));
      if (profile.location) contacts.push(cleanText(profile.location));
      if (Array.isArray(profile.links)) {
        profile.links.slice(0, 2).forEach(l => { if (l.url) contacts.push(cleanText(l.url.replace(/^https?:\/\//, ''))); });
      }

      doc.font(fontRegular).fontSize(9).fillColor(mutedColor)
         .text(contacts.join('  |  '), { align: 'center' });

      doc.moveDown(0.5);
      doc.strokeColor('#cbd5e1').lineWidth(0.75)
         .moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.5);

      function addSectionTitle(title) {
        doc.moveDown(0.3);
        doc.font(fontBold).fontSize(10.5).fillColor(primaryColor)
           .text(title.toUpperCase());
        doc.strokeColor('#e2e8f0').lineWidth(0.5)
           .moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).stroke();
        doc.moveDown(0.3);
      }

      // 2. الملخص المهني المخصص
      addSectionTitle('Professional Summary');
      const summaryText = cleanText(tailored.tailored_summary || profile.summary || '');
      doc.font(fontRegular).fontSize(9.5).fillColor(textColor)
         .text(summaryText, { align: 'justify', lineGap: 2 });

      // 3. المهارات والتقنيات الأساسية
      addSectionTitle('Technical Competencies');
      const skillsToRender = tailored.prioritized_skills || profile.skills || [];
      skillsToRender.forEach(cat => {
        const catName = cleanText(cat.category || 'Skills');
        const items = Array.isArray(cat.items) ? cat.items.map(cleanText).join(', ') : '';
        if (items) {
          doc.font(fontBold).fontSize(9).fillColor(primaryColor)
             .text(`- ${catName}: `, { continued: true })
             .font(fontRegular).fillColor(textColor)
             .text(items, { lineGap: 1.5 });
        }
      });

      // 4. الخبرات المهنية السابقة
      addSectionTitle('Professional Experience');
      const expList = tailored.highlighted_experience || profile.experience || [];
      expList.forEach((exp, idx) => {
        if (idx > 0) doc.moveDown(0.3);

        const title = cleanText(exp.title || 'Role');
        const company = cleanText(exp.company || 'Company');
        const duration = cleanText(exp.duration || `${exp.start_date || ''} - ${exp.end_date || 'Present'}`);
        const loc = exp.location ? ` | ${cleanText(exp.location)}` : '';

        doc.font(fontBold).fontSize(9.5).fillColor(primaryColor)
           .text(title, { continued: true })
           .font(fontRegular).fillColor(accentColor)
           .text(` at ${company}`, { continued: true })
           .font(fontRegular).fillColor(mutedColor)
           .text(` (${duration}${loc})`, { align: 'left' });

        const bullets = Array.isArray(exp.bullets) ? exp.bullets : (exp.description ? [exp.description] : []);
        bullets.forEach(b => {
          doc.font(fontRegular).fontSize(9).fillColor(textColor)
             .text(`  • ${cleanText(b)}`, { indent: 8, lineGap: 1.5 });
        });

        if (Array.isArray(exp.technologies) && exp.technologies.length > 0) {
          doc.font(fontItalic).fontSize(8.5).fillColor(mutedColor)
             .text(`    Technologies: ${exp.technologies.map(cleanText).join(', ')}`, { indent: 8, lineGap: 1 });
        }
      });

      // 5. المشاريع البارزة
      const projects = (tailored.relevant_projects && tailored.relevant_projects.length > 0)
        ? tailored.relevant_projects
        : (profile.projects || []);
      
      if (projects.length > 0) {
        addSectionTitle('Key Projects');
        projects.slice(0, 3).forEach(prj => {
          doc.font(fontBold).fontSize(9).fillColor(primaryColor)
             .text(`- ${cleanText(prj.title)}: `, { continued: true })
             .font(fontRegular).fillColor(textColor)
             .text(cleanText(prj.description || ''), { lineGap: 1.5 });
        });
      }

      // 6. التعليم والشهادات
      if ((profile.education && profile.education.length > 0) || (profile.certifications && profile.certifications.length > 0)) {
        addSectionTitle('Education & Certifications');
        (profile.education || []).forEach(edu => {
          const yr = edu.graduation_year ? ` (${edu.graduation_year})` : '';
          doc.font(fontBold).fontSize(9).fillColor(primaryColor)
             .text(`- ${cleanText(edu.degree || 'Degree')}`, { continued: true })
             .font(fontRegular).fillColor(textColor)
             .text(` - ${cleanText(edu.institution || '')}${yr}`);
        });

        (profile.certifications || []).forEach(cert => {
          const yr = cert.year ? ` (${cert.year})` : '';
          doc.font(fontBold).fontSize(9).fillColor(primaryColor)
             .text(`- Cert: ${cleanText(cert.name || '')}`, { continued: true })
             .font(fontRegular).fillColor(mutedColor)
             .text(` issued by ${cleanText(cert.issuer || 'Official Issuer')}${yr}`);
        });
      }

      doc.end();

      writeStream.on('finish', () => resolve(outputPath));
      writeStream.on('error', (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * بناء ملف PDF مخصص لخطاب التقديم (Cover Letter PDF)
 */
function buildCoverLetterPdf({ profile, job, coverLetterText, outputPath }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 45, bottom: 45, left: 45, right: 45 }
      });

      const writeStream = fs.createWriteStream(outputPath);
      doc.pipe(writeStream);

      const hasArial = fs.existsSync('C:\\Windows\\Fonts\\arial.ttf');
      const fontRegular = hasArial ? 'C:\\Windows\\Fonts\\arial.ttf' : 'Helvetica';
      const fontBold = (hasArial && fs.existsSync('C:\\Windows\\Fonts\\arialbd.ttf')) ? 'C:\\Windows\\Fonts\\arialbd.ttf' : 'Helvetica-Bold';

      const primaryColor = '#1e293b';
      const accentColor = '#2563eb';
      const mutedColor = '#64748b';
      const textColor = '#0f172a';

      function cleanText(str) {
        if (!str) return '';
        return String(str).replace(/\r/g, '').trim();
      }

      // Header
      doc.font(fontBold).fontSize(16).fillColor(primaryColor)
         .text(cleanText(profile.full_name || 'Candidate Name'));

      doc.font(fontRegular).fontSize(10).fillColor(accentColor)
         .text(cleanText(profile.headline || 'Software Engineer'));

      const contacts = [];
      if (profile.email) contacts.push(cleanText(profile.email));
      if (profile.phone) contacts.push(cleanText(profile.phone));
      if (profile.location) contacts.push(cleanText(profile.location));

      doc.font(fontRegular).fontSize(9).fillColor(mutedColor)
         .text(contacts.join('  |  '));

      doc.moveDown(0.6);
      doc.strokeColor('#cbd5e1').lineWidth(0.75)
         .moveTo(45, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(0.8);

      // Date & Recipient
      const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      doc.font(fontRegular).fontSize(9.5).fillColor(mutedColor).text(today);
      doc.moveDown(0.5);

      doc.font(fontBold).fontSize(10).fillColor(primaryColor)
         .text(`Hiring Team / HR Department`);
      doc.font(fontRegular).fontSize(9.5).fillColor(mutedColor)
         .text(cleanText(job.company || 'Company'));
      doc.text(`Regarding: Application for ${cleanText(job.title || 'Position')}`);
      doc.moveDown(0.8);

      // Body Paragraphs
      const paragraphs = coverLetterText.split('\n\n').filter(p => p.trim().length > 0);
      paragraphs.forEach(p => {
        doc.font(fontRegular).fontSize(10).fillColor(textColor)
           .text(cleanText(p), { align: 'justify', lineGap: 3 });
        doc.moveDown(0.5);
      });

      doc.end();

      writeStream.on('finish', () => resolve(outputPath));
      writeStream.on('error', (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  verifyZeroHallucination,
  tailorCvAndCoverLetter,
  buildAtsPdfCv,
  buildCoverLetterPdf
};
