// 工具分类元信息，为未来工具级权限控制打地基
export interface ToolMeta {
  name: string;
  readOnly: boolean;
  category: 'discovery' | 'exec' | 'file' | 'monitor' | 'audit' | 'system';
  sensitive?: boolean;  // 敏感操作标记，后续 RBAC 系统对非 admin 默认拒绝
}

export const TOOL_META: ToolMeta[] = [
  { name: 'warpgate_list_targets', readOnly: true, category: 'discovery' },
  { name: 'warpgate_health_check', readOnly: true, category: 'discovery' },
  { name: 'warpgate_exec', readOnly: false, category: 'exec' },
  { name: 'warpgate_upload', readOnly: false, category: 'file' },
  { name: 'warpgate_download', readOnly: true, category: 'file' },
  { name: 'warpgate_read_file', readOnly: true, category: 'file' },
  { name: 'warpgate_edit_file', readOnly: false, category: 'file' },
  { name: 'warpgate_stats', readOnly: true, category: 'monitor' },
  { name: 'warpgate_alert_list', readOnly: true, category: 'monitor' },
  { name: 'warpgate_alert_create', readOnly: false, category: 'monitor' },
  { name: 'warpgate_alert_delete', readOnly: false, category: 'monitor' },
  { name: 'warpgate_audit_query', readOnly: true, category: 'audit' },
  { name: 'warpgate_audit_stats', readOnly: true, category: 'audit' },
  { name: 'warpgate_deps_check', readOnly: true, category: 'system' },
  { name: 'warpgate_config_get', readOnly: true, category: 'system' },
  { name: 'warpgate_config_set', readOnly: false, category: 'system' },
  { name: 'warpgate_add_target', readOnly: false, category: 'system', sensitive: true },
  { name: 'warpgate_edit_target', readOnly: false, category: 'system', sensitive: true },
  { name: 'warpgate_remove_target', readOnly: false, category: 'system', sensitive: true },
  { name: 'warpgate_get_target', readOnly: true, category: 'discovery' },
];

export function isReadOnly(toolName: string): boolean {
  return TOOL_META.find(t => t.name === toolName)?.readOnly ?? false;
}
