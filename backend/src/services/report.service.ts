import PDFDocument from 'pdfkit';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '../config/database.js';
import { MetricRegistry } from '../metrics/index.js';
import { marketReadinessService } from './market-readiness.service.js';
import { achievementsService } from './achievements.service.js';
import { gitHubService } from '../integrations/github/github.service.js';
import { TrackerSource } from '@prisma/client';
import { resumeCompositionService } from './career/resume-composition.service.js';
import type { ResumeContext } from '../types/resume-context.js';
import { storageService } from './storage/storage.service.js';

async function loadPhotoBuffer(keyOrUrl: string): Promise<Buffer | null> {
  try {
    const file = await storageService.get(keyOrUrl);
    if (!file) return null;
    if (Buffer.isBuffer(file.data)) return file.data as Buffer;
    return null;
  } catch {
    return null;
  }
}

const COMPLETION_CHECKS = [
  { key: 'name', label: 'Name', weight: 0.25 },
  { key: 'targetRole', label: 'Target Role', weight: 0.25 },
  { key: 'photoId', label: 'Photo', weight: 0.25 },
  { key: 'description', label: 'Description', weight: 0.25 },
] as const;

function computeCompletion(profile: Record<string, unknown>): number {
  const filled = COMPLETION_CHECKS.reduce((sum, c) => {
    const v = profile[c.key];
    return sum + (v !== null && v !== undefined && v !== '' ? c.weight : 0);
  }, 0);
  return Math.round(filled * 100);
}

export class ReportService {
  public async generateCareerSnapshot(userId: string): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      try {
        // ─── Core Career Studio Data ────────────────────────────────────
        const careerProfile = await prisma.careerProfile.findUnique({
          where: { userId },
          include: {
            photos: { where: { isDefault: true }, take: 1 },
          },
        });

        const resumeProfiles = await prisma.resumeProfile.findMany({
          where: { careerProfileId: careerProfile?.id ?? '' },
          include: { photo: true },
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
        });

        // ─── Platform Context Data ──────────────────────────────────────
        const [
          readinessData,
          cgpaMetric,
          creditsMetric,
          leetcodeMetric,
          codeforcesMetric,
          projectsCountMetric,
          githubActivityMetric,
          rawGoals,
          achievementsData,
          projects,
        ] = await Promise.all([
          marketReadinessService.compute(userId).catch(() => ({ overall: 0 })),
          MetricRegistry.resolve(TrackerSource.VIT_CGPA, userId).catch(() => ({ current: 0 })),
          MetricRegistry.resolve(TrackerSource.VIT_CREDITS, userId).catch(() => ({ current: 0 })),
          MetricRegistry.resolve(TrackerSource.LEETCODE_SOLVED, userId).catch(() => ({ current: 0 })),
          MetricRegistry.resolve(TrackerSource.CODEFORCES_RATING, userId).catch(() => ({ current: 0 })),
          MetricRegistry.resolve(TrackerSource.PROJECTS_COMPLETED, userId).catch(() => ({ current: 0 })),
          MetricRegistry.resolve(TrackerSource.GITHUB_ACTIVITY, userId).catch(() => ({ current: 0 })),
          prisma.goal.findMany({ where: { userId }, take: 5 }),
          achievementsService.getAll(userId).catch(() => []),
          prisma.projectEntry.findMany({ where: { userId }, select: { techStack: true } }),
        ]);

        const goals = await Promise.all(rawGoals.map(async (g) => {
          let actualCurrent = g.current;
          if (g.trackerSource !== 'MANUAL') {
            const m = await MetricRegistry.resolve(g.trackerSource, userId).catch(() => ({ current: 0 }));
            actualCurrent = m.current;
          }
          return { ...g, current: actualCurrent };
        }));

        let topProjectName = 'N/A';
        let topProjectActivity = '';
        const user = await prisma.user.findUnique({ where: { id: userId } });
        const ghUsername = user?.githubUsername || (careerProfile?.github ? careerProfile.github.match(/(?:github\.com\/)([^\/]+)/)?.[1] : null);
        if (ghUsername) {
          try {
            const ghAnalytics = await gitHubService.getAnalytics(userId, ghUsername);
            if (ghAnalytics.topProjects?.length > 0) {
              topProjectName = ghAnalytics.topProjects[0].name;
              topProjectActivity = `Quality Score: ${ghAnalytics.topProjects[0].score}/100`;
            }
          } catch { /* skip */ }
        }

        const IGNORED_SKILLS = new Set(['html', 'css', 'html5', 'css3', 'markdown', 'scss', 'sass', 'less']);
        const skillCounts: Record<string, number> = {};
        projects.forEach(p => {
          if (Array.isArray(p.techStack)) {
            p.techStack.forEach(t => {
              const cleaned = t.trim();
              if (!IGNORED_SKILLS.has(cleaned.toLowerCase())) {
                skillCounts[cleaned] = (skillCounts[cleaned] || 0) + 1;
              }
            });
          }
        });
        const topSkills = Object.entries(skillCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
        const unlockedAchievements = achievementsData.filter(a => a.unlocked).slice(0, 4);

        // ─── PDF Generation ────────────────────────────────────────────
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers: Buffer[] = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        const primaryColor = '#FF9933';
        const textColor = '#1E293B';
        const secondaryColor = '#64748B';
        const tertiaryColor = '#128807';
        const borderColor = '#E5E7EB';

        // ═══ 1. HEADER ═══
        doc.font('Helvetica-Bold').fontSize(24).fillColor(primaryColor).text('ProgressOS', { align: 'center' });
        doc.font('Helvetica').fontSize(12).fillColor(secondaryColor).text('Career Snapshot', { align: 'center' });
        doc.moveDown(0.5);
        const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        doc.fontSize(10).fillColor('#94a3b8').text(`Generated: ${today}`, { align: 'center' });
        doc.moveDown(1.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(1).stroke(borderColor);
        doc.moveDown(1.5);

        // ═══ 2. PROFESSIONAL PROFILE (RESUME HEADER) ═══
        const profileName = careerProfile?.fullName || 'Professional Profile';
        const profileTitle = careerProfile?.professionalTitle || '';
        const sectionStartY = doc.y;
        const photoSize = 100;
        const photoX = 545 - photoSize; // right-aligned within content area

        // Try to load photo
        let photoBuffer: Buffer | null = null;
        const defaultPhoto = careerProfile?.photos?.[0];
        if (defaultPhoto?.storageKey) {
          photoBuffer = await loadPhotoBuffer(defaultPhoto.storageKey);
        }

        // Draw photo on the right (if available)
        const textAreaWidth = photoBuffer ? 545 - 50 - photoSize - 20 : 495; // 50 margin left, gap, photo
        if (photoBuffer) {
          // Square photo with subtle border
          doc.save();
          // Clip to circle
          doc.circle(photoX + photoSize / 2, sectionStartY + photoSize / 2, photoSize / 2);
          doc.clip();
          doc.image(photoBuffer, photoX, sectionStartY, { fit: [photoSize, photoSize], align: 'center', valign: 'center' });
          doc.restore();
          // Border ring
          doc.circle(photoX + photoSize / 2, sectionStartY + photoSize / 2, photoSize / 2 + 1)
             .lineWidth(2).strokeColor(primaryColor).stroke();
        }

        // Name (left side)
        doc.font('Helvetica-Bold').fontSize(22).fillColor(textColor);
        doc.text(profileName, 50, sectionStartY, { width: textAreaWidth });

        // Title
        let currentY = doc.y;
        if (profileTitle) {
          doc.font('Helvetica').fontSize(13).fillColor(primaryColor);
          doc.text(profileTitle, 50, doc.y, { width: textAreaWidth });
          currentY = doc.y;
        }

        // Contact info
        const contactParts: string[] = [];
        if (careerProfile?.email) contactParts.push(careerProfile.email);
        if (careerProfile?.phone) contactParts.push(careerProfile.phone);
        if (careerProfile?.location) contactParts.push(careerProfile.location);
        if (contactParts.length > 0) {
          doc.font('Helvetica').fontSize(9).fillColor(secondaryColor);
          doc.text(contactParts.join('  |  '), 50, doc.y, { width: textAreaWidth });
        }

        // Links (clickable)
        const linkEntries: { label: string; url: string }[] = [];
        if (careerProfile?.linkedin) linkEntries.push({ label: 'LinkedIn', url: careerProfile.linkedin });
        if (careerProfile?.github) linkEntries.push({ label: 'GitHub', url: careerProfile.github });
        if (careerProfile?.portfolio) linkEntries.push({ label: 'Portfolio', url: careerProfile.portfolio });
        if (careerProfile?.website) linkEntries.push({ label: 'Website', url: careerProfile.website });
        if (careerProfile?.leetcode) linkEntries.push({ label: 'LeetCode', url: careerProfile.leetcode });
        if (careerProfile?.codeforces) linkEntries.push({ label: 'Codeforces', url: careerProfile.codeforces });
        if (linkEntries.length > 0) {
          doc.font('Helvetica').fontSize(9).fillColor('#2563EB');
          const linkStartY = doc.y;
          let linkCursorX = 50;
          const gap = 16;
          linkEntries.forEach((entry) => {
            const w = doc.widthOfString(entry.label);
            doc.text(entry.label, linkCursorX, linkStartY);
            doc.link(linkCursorX, linkStartY - 1, w + 2, 12, entry.url);
            linkCursorX += w + gap;
          });
          doc.y = linkStartY + 14;
        }

        // Bio
        if (careerProfile?.bio) {
          doc.moveDown(0.3);
          doc.font('Helvetica-Oblique').fontSize(10).fillColor(textColor);
          doc.text(careerProfile.bio, 50, doc.y, { width: textAreaWidth });
        }

        // Ensure we clear the photo area height
        const headerBottomY = Math.max(doc.y, sectionStartY + photoSize + 10);

        // Market Readiness
        if (readinessData.overall > 0) {
          doc.y = headerBottomY;
          doc.moveDown(0.3);
          doc.font('Helvetica-Bold').fontSize(11).fillColor(textColor).text('Market Readiness', 50, doc.y, { continued: true });
          doc.font('Helvetica').fillColor(primaryColor).text(`  ${readinessData.overall}/100`);
        } else {
          doc.y = headerBottomY;
        }

        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke(borderColor);
        doc.moveDown(1.5);

        // ═══ 3. RESUME PROFILES ═══
        doc.font('Helvetica-Bold').fontSize(16).fillColor(textColor).text('Resume Profiles');
        doc.moveDown(0.5);

        if (resumeProfiles.length > 0) {
          resumeProfiles.forEach((rp, i) => {
            const pct = computeCompletion(rp as unknown as Record<string, unknown>);

            // Profile name + default badge
            doc.font('Helvetica-Bold').fontSize(12).fillColor(textColor).text(
              `${rp.name}${rp.isDefault ? '  [Default]' : ''}`
            );
            doc.font('Helvetica').fontSize(10).fillColor(secondaryColor).text(`Target: ${rp.targetRole}`);

            // Config badges
            const configParts = [
              `Template: ${rp.template.charAt(0).toUpperCase() + rp.template.slice(1)}`,
              `Page: ${rp.pageSize.toUpperCase()}`,
              `Completion: ${pct}%`,
            ];
            if (rp.photo) configParts.push('Photo: Yes');
            doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(configParts.join('  •  '));

            if (rp.description) {
              doc.font('Helvetica-Oblique').fontSize(9).fillColor(secondaryColor).text(rp.description, { indent: 10 });
            }

            doc.moveDown(0.5);
            if (i < resumeProfiles.length - 1) {
              doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).stroke(borderColor);
              doc.moveDown(0.5);
            }
          });
        } else {
          doc.font('Helvetica').fontSize(11).fillColor(secondaryColor).text('No resume profiles yet.');
        }

        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke(borderColor);
        doc.moveDown(1.5);

        // ═══ 4. CAREER HIGHLIGHTS (Context Data) ═══
        doc.font('Helvetica-Bold').fontSize(16).fillColor(textColor).text('Career Highlights');
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(10).fillColor(secondaryColor);

        const highlights: string[] = [];
        if (leetcodeMetric.current > 0) highlights.push(`${leetcodeMetric.current} LeetCode Problems`);
        if (codeforcesMetric.current > 0) highlights.push(`Codeforces: ${codeforcesMetric.current}`);
        if (cgpaMetric.current > 0) highlights.push(`CGPA: ${cgpaMetric.current}`);
        if (projectsCountMetric.current > 0) highlights.push(`${projectsCountMetric.current} Projects Completed`);
        if (githubActivityMetric.current > 0) highlights.push(`${githubActivityMetric.current} GitHub Repositories`);
        if (creditsMetric.current > 0) highlights.push(`${creditsMetric.current} Credits Earned`);

        if (highlights.length > 0) {
          doc.text('•  ' + highlights.join('\n•  '));
        } else {
          doc.text('No career data logged yet. Start tracking to see highlights here.');
        }

        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke(borderColor);
        doc.moveDown(1.5);

        // ═══ 5. TOP SKILLS ═══
        doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text('Top Skills');
        doc.moveDown(0.5);
        doc.font('Helvetica').fontSize(11).fillColor(secondaryColor);
        if (topSkills.length > 0) {
          doc.text(topSkills.join('  •  '));
        } else {
          doc.text('No skills logged yet.');
        }
        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke(borderColor);
        doc.moveDown(1.5);

        // ═══ 6. CURRENT GOALS ═══
        doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text('Current Goals');
        doc.moveDown(0.5);
        if (goals.length > 0) {
          goals.forEach(g => {
            const pct = g.target > 0 ? Math.min(100, Math.round((g.current / g.target) * 100)) : 0;
            doc.font('Helvetica-Bold').fontSize(11).fillColor(textColor).text(g.title, { continued: true });
            doc.font('Helvetica').fillColor(primaryColor).text(`  ${pct}%`);
            doc.moveDown(0.2);
          });
        } else {
          doc.font('Helvetica').fontSize(11).fillColor(secondaryColor).text('No active goals.');
        }
        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke(borderColor);
        doc.moveDown(1.5);

        // ═══ 7. RECENT ACHIEVEMENTS ═══
        doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text('Recent Achievements');
        doc.moveDown(0.5);
        if (unlockedAchievements.length > 0) {
          unlockedAchievements.forEach(a => {
            doc.font('Helvetica-Bold').fontSize(11).fillColor(textColor).text(`\u2022 ${a.title}`);
            doc.moveDown(0.2);
          });
        } else {
          doc.font('Helvetica').fontSize(11).fillColor(secondaryColor).text('Keep building to unlock achievements!');
        }
        doc.moveDown(1);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke(borderColor);

        // ═══ 8. FOOTER ═══
        doc.moveDown(2);
        doc.font('Helvetica').fontSize(10).fillColor('#94a3b8').text('Generated by ProgressOS', { align: 'center' });

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  public async generateResumePDF(userId: string, resumeProfileId: string): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      try {
        const ctx = await resumeCompositionService.buildResumeContext(userId, resumeProfileId);
        const { sections, sectionOrder, visibility, sectionLabels, metadata } = ctx;

        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const buffers: Buffer[] = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        const primaryColor = '#FF9933';
        const textColor = '#1E293B';
        const secondaryColor = '#64748B';
        const borderColor = '#E5E7EB';
        const photoSize = 100;
        const photoX = 545 - photoSize;

        // ─── Header ─────────────────────────────────────────────────────
        const profileName = sections.profile.fullName || 'Resume';
        const profileTitle = sections.profile.professionalTitle || '';
        const sectionStartY = doc.y;

        let photoBuffer: Buffer | null = null;
        if (sections.photo?.url) {
          const photoKey = path.basename(sections.photo.url);
          photoBuffer = await loadPhotoBuffer(photoKey);
        }

        const textAreaWidth = photoBuffer ? 545 - 50 - photoSize - 20 : 495;

        if (photoBuffer) {
          doc.save();
          doc.circle(photoX + photoSize / 2, sectionStartY + photoSize / 2, photoSize / 2);
          doc.clip();
          doc.image(photoBuffer, photoX, sectionStartY, { fit: [photoSize, photoSize], align: 'center', valign: 'center' });
          doc.restore();
          doc.circle(photoX + photoSize / 2, sectionStartY + photoSize / 2, photoSize / 2 + 1)
             .lineWidth(2).strokeColor(primaryColor).stroke();
        }

        doc.font('Helvetica-Bold').fontSize(22).fillColor(textColor);
        doc.text(profileName, 50, sectionStartY, { width: textAreaWidth });

        if (profileTitle) {
          doc.font('Helvetica').fontSize(13).fillColor(primaryColor);
          doc.text(profileTitle, 50, doc.y, { width: textAreaWidth });
        }

        const contactParts: string[] = [];
        if (sections.profile.email) contactParts.push(sections.profile.email);
        if (sections.profile.phone) contactParts.push(sections.profile.phone);
        if (sections.profile.location) contactParts.push(sections.profile.location);
        if (contactParts.length > 0) {
          doc.font('Helvetica').fontSize(9).fillColor(secondaryColor);
          doc.text(contactParts.join('  |  '), 50, doc.y, { width: textAreaWidth });
        }

        const linkEntries: { label: string; url: string }[] = [];
        if (sections.profile.linkedin) linkEntries.push({ label: 'LinkedIn', url: sections.profile.linkedin });
        if (sections.profile.portfolio) linkEntries.push({ label: 'Portfolio', url: sections.profile.portfolio });
        if (sections.profile.website) linkEntries.push({ label: 'Website', url: sections.profile.website });
        sections.codingProfiles.filter(cp => cp.enabled).forEach(cp => {
          if (cp.url) linkEntries.push({ label: cp.label, url: cp.url });
        });
        if (linkEntries.length > 0) {
          doc.font('Helvetica').fontSize(9).fillColor('#2563EB');
          const linkStartY = doc.y;
          let linkCursorX = 50;
          const gap = 16;
          linkEntries.forEach((entry) => {
            const w = doc.widthOfString(entry.label);
            doc.text(entry.label, linkCursorX, linkStartY);
            doc.link(linkCursorX, linkStartY - 1, w + 2, 12, entry.url);
            linkCursorX += w + gap;
          });
          doc.y = linkStartY + 14;
        }

        const headerBottomY = Math.max(doc.y, sectionStartY + (photoBuffer ? photoSize + 10 : 0));
        doc.y = headerBottomY;
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke(borderColor);
        doc.moveDown(1);

        // ─── Render sections in configured order ────────────────────────

        for (const key of sectionOrder) {
          if (visibility?.[key] === false) continue;

          const label = sectionLabels?.[key] || key.charAt(0).toUpperCase() + key.slice(1);

          if (key === 'summary') {
            const bio = sections.profile.bio;
            if (bio) {
              doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text('Professional Summary');
              doc.moveDown(0.3);
              doc.font('Helvetica-Oblique').fontSize(10).fillColor(textColor);
              doc.text(bio, 50, doc.y, { width: 495 });
              doc.moveDown(0.5);
            }
          } else if (key === 'projects' && sections.projects.length > 0) {
            doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text(label);
            doc.moveDown(0.3);
            sections.projects.forEach((proj) => {
              doc.font('Helvetica-Bold').fontSize(11).fillColor(textColor).text(proj.title);
              if (proj.description) {
                doc.font('Helvetica').fontSize(9).fillColor(secondaryColor);
                doc.text(proj.description, { width: 495 });
              }
              if (proj.techStack.length > 0) {
                doc.font('Helvetica').fontSize(8).fillColor(primaryColor);
                doc.text(proj.techStack.join('  •  '));
              }
              if (proj.bullets.length > 0) {
                doc.font('Helvetica').fontSize(9).fillColor(secondaryColor);
                proj.bullets.forEach(b => {
                  doc.text(`\u2022  ${b}`, { indent: 10, width: 485 });
                });
              }
              doc.moveDown(0.3);
            });
          } else if (key === 'skills' && sections.skills.length > 0) {
            doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text(label);
            doc.moveDown(0.3);
            doc.font('Helvetica').fontSize(10).fillColor(secondaryColor);
            doc.text(sections.skills.join('  •  '));
            doc.moveDown(0.5);
          } else if (key === 'certificates' && sections.certificates.length > 0) {
            doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text(label);
            doc.moveDown(0.3);
            sections.certificates.forEach((cert) => {
              doc.font('Helvetica-Bold').fontSize(10).fillColor(textColor).text(cert.name);
              if (cert.issuer) {
                doc.font('Helvetica').fontSize(9).fillColor(secondaryColor).text(cert.issuer, { indent: 10 });
              }
              doc.moveDown(0.2);
            });
          } else if (key === 'achievements' && sections.achievements.length > 0) {
            doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text(label);
            doc.moveDown(0.3);
            sections.achievements.forEach((a) => {
              doc.font('Helvetica').fontSize(10).fillColor(textColor);
              doc.text(`\u2022  ${a.title}${a.source ? `  (${a.source})` : ''}`, { width: 495 });
              doc.moveDown(0.1);
            });
          } else if (key === 'education' && sections.education) {
            doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text(label);
            doc.moveDown(0.3);
            doc.font('Helvetica-Bold').fontSize(10).fillColor(textColor).text(sections.education.institution);
            if (sections.education.cgpa !== null) {
              doc.font('Helvetica').fontSize(10).fillColor(secondaryColor).text(`CGPA: ${sections.education.cgpa}`);
            }
            doc.moveDown(0.5);
          } else if (key === 'codingProfiles') {
            const enabled = sections.codingProfiles.filter(cp => cp.enabled);
            if (enabled.length > 0) {
              doc.font('Helvetica-Bold').fontSize(14).fillColor(textColor).text('Coding Profiles');
              doc.moveDown(0.3);
              enabled.forEach(cp => {
                doc.font('Helvetica').fontSize(10).fillColor(textColor);
                const line = `${cp.label}${cp.username ? ` — ${cp.username}` : ''}`;
                doc.text(line, { indent: 10 });
                doc.moveDown(0.1);
              });
            }
          }

          doc.moveDown(0.5);
          doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).stroke(borderColor);
          doc.moveDown(0.8);
        }

        // ─── Footer ─────────────────────────────────────────────────────
        doc.font('Helvetica').fontSize(9).fillColor('#94a3b8');
        doc.text(`Generated by ProgressOS  |  ${metadata.profileName}  |  ${new Date().toLocaleDateString('en-GB')}`, { align: 'center' });

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }
}

export const reportService = new ReportService();
