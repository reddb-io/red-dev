import { expect, test } from 'bun:test';
import { redSkillsReleaseRepo } from './red-skills-acquire';
import { REDSKILLS_RELEASE_IDENTITY } from './red-skills-set';
test('old exact releases remain installable while new releases use Redskilled', () => {
  for (const v of ['3.19.5','v4.4.1']) expect(redSkillsReleaseRepo(v)).toBe('reddb-io/red-skills');
  for (const v of ['4.5.0','v4.5.0-beta.1','5.0.0','stable','latest']) expect(redSkillsReleaseRepo(v)).toBe('reddb-io/redskilled');
});
test('signature trust includes both known publishers and no other repository', () => {
 const re=new RegExp(REDSKILLS_RELEASE_IDENTITY);
 for(const repo of ['red-skills','redskilled']) expect(re.test(`https://github.com/reddb-io/${repo}/.github/workflows/red-publish.yml@refs/tags/v4.5.0`)).toBe(true);
 expect(re.test('https://github.com/other/redskilled/.github/workflows/red-publish.yml@refs/tags/v4.5.0')).toBe(false);
});
