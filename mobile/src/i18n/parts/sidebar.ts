/**
 * Words for the phone's groups, which the web app's catalog no longer has since it replaced groups with
 * spaces; the rest of the phone's sidebar words come from the web app's catalog.
 */
export const tr = {
  'groups.hint':
    'Gruplar kenar çubuğunu düzenler ve gruptaki botlara ortak bir klasör verir. Bütün botlar birbirine yazabilir.',
  'groups.placeholder': 'Yeni grup adı',
  'groups.empty': 'Grup yok.',
  'sidebar.ungrouped': 'Grupsuz',
  'sidebarMenu.newGroupItem': 'Yeni grup…',
  'sidebarMenu.newGroup': 'Yeni grup',
  'sidebarMenu.deleteGroupConfirm':
    '"{name}" grubu silinsin mi? İçindeki botlar Grupsuz\'a taşınır ve grubun ortak klasörüne erişemez.',
  'bot.noGroup': 'Grupsuz',
  'bot.newGroup': 'ya da yeni grup adı',
};

export const en: Record<keyof typeof tr, string> = {
  'groups.hint':
    'Groups arrange the sidebar and give their bots a shared folder. All bots can write to each other.',
  'groups.placeholder': 'New group name',
  'groups.empty': 'No groups.',
  'sidebar.ungrouped': 'Ungrouped',
  'sidebarMenu.newGroupItem': 'New group…',
  'sidebarMenu.newGroup': 'New group',
  'sidebarMenu.deleteGroupConfirm':
    'Delete the group "{name}"? Its bots move to Ungrouped and lose access to the group\'s shared folder.',
  'bot.noGroup': 'No group',
  'bot.newGroup': 'or a new group name',
};
