import { Redirect, useLocalSearchParams } from 'expo-router';
import { back, Page } from '@/components/page';
import { closeSectionForm } from '@/components/settings/common/sectionBack';
import { isSection } from '@/components/settings/sections';
import { ProfileSection } from '@/components/settings/ProfileSection';
import { GeneralSection } from '@/components/settings/GeneralSection';
import { ConnectionSection } from '@/components/settings/ConnectionSection';
import { ChannelsSection } from '@/components/settings/ChannelsSection';
import { PermissionsSection } from '@/components/settings/PermissionsSection';
import { VaultSection } from '@/components/settings/VaultSection';
import { MemorySection } from '@/components/settings/MemorySection';
import { RoutinesSection } from '@/components/settings/RoutinesSection';
import { SkillsSection } from '@/components/settings/SkillsSection';
import { GroupsSection } from '@/components/settings/GroupsSection';
import { ImportSection } from '@/components/settings/ImportSection';
import { UsageSection } from '@/components/settings/UsageSection';
import { AboutSection } from '@/components/settings/AboutSection';
import { PeopleSection } from '@/components/settings/PeopleSection';
import { ProvidersSection } from '@/components/settings/ProvidersSection';
import { ServicesSection } from '@/components/settings/ServicesSection';
import { t } from '@/i18n';

/** One settings section with its own title bar and the way back to the list. */
export default function SettingsSection() {
  const { section } = useLocalSearchParams<{ section: string }>();
  if (!isSection(section)) return <Redirect href="/settings" />;
  return (
    <Page title={t(`settings.tab.${section}`)} onBack={() => (closeSectionForm() ? undefined : back())}>
      {section === 'profile' && <ProfileSection />}
      {section === 'general' && <GeneralSection />}
      {section === 'providers' && <ProvidersSection />}
      {section === 'services' && <ServicesSection />}
      {section === 'people' && <PeopleSection />}
      {section === 'connection' && <ConnectionSection />}
      {section === 'channels' && <ChannelsSection />}
      {section === 'permissions' && <PermissionsSection />}
      {section === 'vault' && <VaultSection />}
      {section === 'memory' && <MemorySection />}
      {section === 'routines' && <RoutinesSection />}
      {section === 'skills' && <SkillsSection />}
      {section === 'groups' && <GroupsSection />}
      {section === 'import' && <ImportSection />}
      {section === 'usage' && <UsageSection />}
      {section === 'about' && <AboutSection />}
    </Page>
  );
}
