'use client'

import React, { useState, useEffect } from 'react'
import { WorkItemType, FieldExtractionConfig, ExtractionMode, ExtractionPreferences, EnhancedWorkItemTemplate } from '../types'
import { JiraField } from '../lib/jira-field-service'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Icons } from './ui/icons'

interface FieldExtractionConfigEditorProps {
  workItemType: WorkItemType
  template: EnhancedWorkItemTemplate
  jiraFields: JiraField[]
  onSave: (config: FieldExtractionConfig[], preferences: ExtractionPreferences) => void
  onCancel: () => void
  onFieldsUpdated?: (fields: JiraField[]) => void
}

interface DiscoveredField extends JiraField {
  usage_stats: {
    usage_percentage: number
    is_popular: boolean
  }
  is_configured: boolean
}

interface CategorizedFields {
  commonly_used: DiscoveredField[]
  project_specific: DiscoveredField[]
  optional_standard: DiscoveredField[]
  system_fields: DiscoveredField[]
}

// Helper function to convert legacy config to new extraction mode
function getExtractionMode(config: any): ExtractionMode {
  // Handle legacy configurations that still have the old boolean properties
  if ('confirmationRequired' in config && 'autoApply' in config) {
    if (config.extractionMethod === 'manual') return 'manual-only'
    if (config.confirmationRequired) return 'always-confirm'
    if (config.autoApply) return 'auto-apply'
    return 'always-confirm' // Default fallback
  }
  // For new configurations, use the extractionMode directly
  return config.extractionMode || 'auto-apply'
}

// Helper function to determine default extraction mode for new fields
function getDefaultExtractionMode(field: JiraField): ExtractionMode {
  if (field.required) return 'auto-apply'
  return 'always-confirm'
}

export function FieldExtractionConfigEditor({
  workItemType,
  template,
  jiraFields,
  onSave,
  onCancel,
  onFieldsUpdated
}: FieldExtractionConfigEditorProps) {
  const [fieldConfigs, setFieldConfigs] = useState<FieldExtractionConfig[]>([])
  const [preferences, setPreferences] = useState<ExtractionPreferences>({
    defaultMethod: 'ai',
    globalConfidenceThreshold: 0.7,
    requireConfirmationForAll: false,
    enableSmartDefaults: true
  })
  const [hasChanges, setHasChanges] = useState(false)

  // Field discovery state
  const [showFieldDiscovery, setShowFieldDiscovery] = useState(false)
  const [discoveredFields, setDiscoveredFields] = useState<CategorizedFields | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [isScanning, setIsScanning] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set())
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())

  useEffect(() => {
    initializeConfigs()
  }, [template, jiraFields])

  const initializeConfigs = () => {
    // Load existing config or create defaults
    const existingConfigs = template.fieldExtractionConfig || []
    const existingPrefs = template.extractionPreferences || preferences

    const configs: FieldExtractionConfig[] = []
    const jiraFieldsMap = new Map(jiraFields.map(field => [field.id, field]))

    // Preserve ALL existing configurations - we'll handle missing field info gracefully
    existingConfigs.forEach(existingConfig => {
      configs.push({
        fieldId: existingConfig.fieldId,
        jiraFieldId: existingConfig.jiraFieldId,
        extractionEnabled: existingConfig.extractionEnabled,
        extractionMethod: existingConfig.extractionMethod,
        extractionMode: getExtractionMode(existingConfig),
        confidenceThreshold: existingConfig.confidenceThreshold,
        displayName: existingConfig.displayName,
        requiredForSubmission: existingConfig.requiredForSubmission ?? false
      })
    })

    // Then, add any new required fields that don't have configurations yet
    const configuredFieldIds = new Set(configs.map(c => c.jiraFieldId))
    jiraFields.forEach(jiraField => {
      if (jiraField.required && !configuredFieldIds.has(jiraField.id)) {
        configs.push({
          fieldId: jiraField.id,
          jiraFieldId: jiraField.id,
          extractionEnabled: true,
          extractionMethod: getDefaultExtractionMethod(jiraField),
          extractionMode: getDefaultExtractionMode(jiraField),
          confidenceThreshold: existingPrefs.globalConfidenceThreshold,
          displayName: jiraField.name,
          requiredForSubmission: false
        })
      }
    })

    setFieldConfigs(configs)
    setPreferences(existingPrefs)
    setHasChanges(false)
  }

  const getDefaultExtractionMethod = (jiraField: JiraField): 'ai' | 'pattern' | 'manual' => {
    const fieldName = jiraField.name.toLowerCase()
    const fieldId = jiraField.id.toLowerCase()

    // Pattern matching works well for these fields
    if (fieldName.includes('priority') || 
        fieldName.includes('quarter') || 
        fieldId.includes('customfield_26362') ||
        fieldId.includes('customfield_26360')) {
      return 'pattern'
    }

    // AI works better for complex fields
    if (fieldName.includes('description') || 
        fieldName.includes('summary') ||
        fieldName.includes('title')) {
      return 'ai'
    }

    // Default to AI for most fields
    return 'ai'
  }

  const updateFieldConfig = (index: number, updates: Partial<FieldExtractionConfig>) => {
    const newConfigs = [...fieldConfigs]
    newConfigs[index] = { ...newConfigs[index], ...updates }
    setFieldConfigs(newConfigs)
    setHasChanges(true)
  }

  const removeFieldConfig = (index: number) => {
    const newConfigs = [...fieldConfigs]
    newConfigs.splice(index, 1)
    setFieldConfigs(newConfigs)
    setHasChanges(true)
  }

  const updatePreferences = (updates: Partial<ExtractionPreferences>) => {
    setPreferences(prev => ({ ...prev, ...updates }))
    setHasChanges(true)
  }

  const applyGlobalSettings = (setting: 'enable' | 'disable' | 'ai' | 'pattern' | 'manual') => {
    const newConfigs = fieldConfigs.map(config => {
      switch (setting) {
        case 'enable':
          return { ...config, extractionEnabled: true }
        case 'disable':
          return { ...config, extractionEnabled: false }
        case 'ai':
        case 'pattern':
        case 'manual':
          return { ...config, extractionMethod: setting }
        default:
          return config
      }
    })
    setFieldConfigs(newConfigs)
    setHasChanges(true)
  }

  const handleSave = () => {
    onSave(fieldConfigs, preferences)
  }

  // Field discovery methods
  const handleDiscoverAllFields = async () => {
    setIsScanning(true)
    setDiscoveryError(null)
    
    try {
      // Get Jira connection from localStorage
      const jiraConnection = JSON.parse(localStorage.getItem('jira-connection') || '{}')
      
      if (!jiraConnection.url) {
        throw new Error('No Jira connection found')
      }

      const response = await fetch('/api/jira/discover-all-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jiraInstance: jiraConnection,
          workItemType,
          searchTerm: searchTerm || undefined
        })
      })

      if (!response.ok) {
        throw new Error('Failed to discover fields')
      }

      const data = await response.json()
      setDiscoveredFields(data.fields)
      setShowFieldDiscovery(true)
      
      // Don't automatically refresh parent fields - this causes the cyclical loop
      // Instead, let the configured fields persist and users can manually refresh if needed
      
      // Auto-expand all categories when searching to show all results
      if (searchTerm.trim() && data.fields) {
        const categories = Object.keys(data.fields).filter(key => 
          data.fields[key as keyof CategorizedFields].length > 0
        )
        setExpandedCategories(new Set(categories))
      }
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : 'Failed to discover fields')
    } finally {
      setIsScanning(false)
    }
  }

  const handleSearchFields = async () => {
    if (!searchTerm.trim()) {
      setDiscoveredFields(null)
      setExpandedCategories(new Set()) // Reset expanded state when clearing search
      return
    }
    
    await handleDiscoverAllFields()
    // Auto-expand all categories when searching to show all results
    // This will be set after the API call completes and discoveredFields is updated
  }

  const handleAddSelectedFields = () => {
    if (!discoveredFields || selectedFields.size === 0) return

    const allDiscoveredFields = [
      ...discoveredFields.commonly_used,
      ...discoveredFields.project_specific,
      ...discoveredFields.optional_standard,
      ...discoveredFields.system_fields
    ]

    const fieldsToAdd = allDiscoveredFields.filter(field => selectedFields.has(field.id))
    
    const newConfigs: FieldExtractionConfig[] = fieldsToAdd.map(field => ({
      fieldId: field.id,
      jiraFieldId: field.id,
      extractionEnabled: true,
      extractionMethod: getDefaultExtractionMethod(field),
      extractionMode: field.usage_stats.is_popular && field.usage_stats.usage_percentage > 80 
        ? 'auto-apply' 
        : 'always-confirm',
      confidenceThreshold: field.usage_stats.is_popular ? 0.8 : 0.7,
      displayName: field.name,
      requiredForSubmission: false
    }))

    setFieldConfigs(prev => [...prev, ...newConfigs])
    setSelectedFields(new Set())
    setShowFieldDiscovery(false)
    setHasChanges(true)
  }

  const toggleFieldSelection = (fieldId: string) => {
    setSelectedFields(prev => {
      const newSet = new Set(prev)
      if (newSet.has(fieldId)) {
        newSet.delete(fieldId)
      } else {
        newSet.add(fieldId)
      }
      return newSet
    })
  }

  const toggleCategoryExpansion = (categoryName: string) => {
    setExpandedCategories(prev => {
      const newSet = new Set(prev)
      if (newSet.has(categoryName)) {
        newSet.delete(categoryName)
      } else {
        newSet.add(categoryName)
      }
      return newSet
    })
  }

  const selectAllInCategory = (fields: DiscoveredField[]) => {
    const unconfiguredFields = fields.filter(f => !f.is_configured)
    setSelectedFields(prev => {
      const newSet = new Set(prev)
      unconfiguredFields.forEach(field => newSet.add(field.id))
      return newSet
    })
  }

  const getMethodIcon = (method: string) => {
    switch (method) {
      case 'ai': return '🤖'
      case 'pattern': return '🔍'
      case 'manual': return '✋'
      default: return '❓'
    }
  }

  const getMethodColor = (method: string) => {
    switch (method) {
      case 'ai': return 'bg-blue-100 text-blue-700'
      case 'pattern': return 'bg-green-100 text-green-700'
      case 'manual': return 'bg-gray-100 text-gray-700'
      default: return 'bg-gray-100 text-gray-700'
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Icons.Settings size="md" autoContrast className="mr-2" />
            Field Extraction Configuration - {workItemType.charAt(0).toUpperCase() + workItemType.slice(1)}
          </CardTitle>
          <CardDescription>
            Configure how fields are extracted from your content when pushing to Jira. 
            Choose extraction methods, confidence thresholds, and confirmation requirements.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center mb-2">
              <Icons.Info size="sm" className="text-blue-600 mr-2" />
              <h4 className="font-medium text-blue-900">Extraction Methods</h4>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-blue-800">
              <div className="flex items-center">
                <span className="mr-2">🤖</span>
                <div>
                  <strong>AI:</strong> Uses AI to understand context and extract complex values
                </div>
              </div>
              <div className="flex items-center">
                <span className="mr-2">🔍</span>
                <div>
                  <strong>Pattern:</strong> Uses regex patterns for structured fields like priorities, quarters
                </div>
              </div>
              <div className="flex items-center">
                <span className="mr-2">✋</span>
                <div>
                  <strong>Manual:</strong> Always requires manual input from user
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Two-Column Layout */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        {/* Main Field Configuration - Left Column (60%) */}
        <div className="xl:col-span-3 space-y-6">
          {/* Field Configuration */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <Icons.FileText size="sm" autoContrast className="mr-2" />
                Field Configuration ({fieldConfigs.length} fields)
              </CardTitle>
              <CardDescription>
                Configure extraction settings for Jira fields 
                ({fieldConfigs.filter(c => jiraFields.find(f => f.id === c.jiraFieldId)?.required).length} required, {fieldConfigs.filter(c => {
                  const field = jiraFields.find(f => f.id === c.jiraFieldId)
                  return field ? !field.required : true // assume optional if field info missing
                }).length} optional)
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Info about configured fields */}
              {fieldConfigs.some(config => !jiraFields.find(f => f.id === config.jiraFieldId)) && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                  <div className="flex items-start">
                    <Icons.Info size="sm" className="text-blue-600 mr-2 mt-0.5" />
                    <div>
                      <h4 className="text-sm font-medium text-blue-900">Additional Fields Configured</h4>
                      <p className="text-sm text-blue-800 mt-1">
                        You have additional optional fields configured beyond the basic required fields. 
                        These will be extracted when pushing content to Jira.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="space-y-4">
                {fieldConfigs.map((config, index) => {
                  const jiraField = jiraFields.find(f => f.id === config.jiraFieldId)
                  const isRequired = jiraField?.required ?? false
                  const fieldExists = !!jiraField
                  
                  return (
                    <div key={config.jiraFieldId} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center">
                          <div className="flex items-center mr-4">
                            <input
                              type="checkbox"
                              checked={config.extractionEnabled}
                              onChange={(e) => updateFieldConfig(index, { extractionEnabled: e.target.checked })}
                              className="mr-2"
                            />
                            <div>
                              <h4 className="font-medium text-gray-900">{config.displayName}</h4>
                              <p className="text-sm text-gray-500">
                                {config.jiraFieldId} • {jiraField?.type || 'Custom field'}
                              </p>
                            </div>
                          </div>
                          {isRequired ? (
                            <Badge variant="secondary">Required</Badge>
                          ) : (
                            <Badge 
                              variant={config.requiredForSubmission ? "default" : "outline"}
                              className={`cursor-pointer transition-colors ${
                                config.requiredForSubmission 
                                  ? "bg-blue-100 text-blue-800 border-blue-300 hover:bg-blue-200" 
                                  : "hover:bg-gray-100"
                              }`}
                              onClick={() => updateFieldConfig(index, { requiredForSubmission: !config.requiredForSubmission })}
                              title="Click to toggle requirement for submission"
                            >
                              {config.requiredForSubmission ? "Required for submission" : "Optional"}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge className={getMethodColor(config.extractionMethod)}>
                            {getMethodIcon(config.extractionMethod)} {config.extractionMethod.toUpperCase()}
                          </Badge>
                          {!isRequired && (
                            <button
                              onClick={() => removeFieldConfig(index)}
                              className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-50"
                              title="Remove this optional field"
                            >
                              <Icons.X size="xs" />
                            </button>
                          )}
                        </div>
                      </div>

                      {config.extractionEnabled && (
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Extraction Method
                            </label>
                            <select
                              value={config.extractionMethod}
                              onChange={(e) => updateFieldConfig(index, { extractionMethod: e.target.value as any })}
                              className="jira-select w-full text-sm"
                            >
                              <option value="ai">🤖 AI Extraction</option>
                              <option value="pattern">🔍 Pattern Matching</option>
                              <option value="manual">✋ Manual Only</option>
                            </select>
                          </div>

                          {config.extractionMethod !== 'manual' && (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                Confidence Threshold
                              </label>
                              <select
                                value={config.confidenceThreshold}
                                onChange={(e) => updateFieldConfig(index, { confidenceThreshold: parseFloat(e.target.value) })}
                                className="jira-select w-full text-sm"
                              >
                                <option value="0.5">50%</option>
                                <option value="0.7">70%</option>
                                <option value="0.8">80%</option>
                                <option value="0.9">90%</option>
                              </select>
                            </div>
                          )}

                          <div className="flex flex-col justify-end">
                            <div>
                              <span className="text-sm font-medium text-gray-700 mb-2 block">Extraction Behavior</span>
                              <div className="space-y-2">
                                <label className="flex items-center text-sm">
                                  <input
                                    type="radio"
                                    name={`extraction-mode-${index}`}
                                    value="auto-apply"
                                    checked={config.extractionMode === 'auto-apply'}
                                    onChange={(e) => updateFieldConfig(index, { extractionMode: e.target.value as ExtractionMode })}
                                    className="mr-2 text-blue-600"
                                  />
                                  Auto-apply when confident
                                </label>
                                <label className="flex items-center text-sm">
                                  <input
                                    type="radio"
                                    name={`extraction-mode-${index}`}
                                    value="always-confirm"
                                    checked={config.extractionMode === 'always-confirm'}
                                    onChange={(e) => updateFieldConfig(index, { extractionMode: e.target.value as ExtractionMode })}
                                    className="mr-2 text-blue-600"
                                  />
                                  Always confirm
                                </label>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>

          {/* Actions - Moved to main column for easy access */}
          <div className="flex justify-between">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button 
              onClick={handleSave}
              className="jira-btn-primary"
            >
              Save Configuration
            </Button>
          </div>
        </div>

        {/* Secondary Panel - Right Column (40%) */}
        <div className="xl:col-span-2 space-y-6">
          {/* Global Preferences */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center text-base">
                <Icons.Settings size="sm" autoContrast className="mr-2" />
                Global Preferences
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Default Extraction Method
                  </label>
                  <select
                    value={preferences.defaultMethod}
                    onChange={(e) => updatePreferences({ defaultMethod: e.target.value as any })}
                    className="jira-select w-full"
                  >
                    <option value="ai">🤖 AI Extraction</option>
                    <option value="pattern">🔍 Pattern Matching</option>
                    <option value="manual">✋ Manual Only</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Global Confidence Threshold
                  </label>
                  <select
                    value={preferences.globalConfidenceThreshold}
                    onChange={(e) => updatePreferences({ globalConfidenceThreshold: parseFloat(e.target.value) })}
                    className="jira-select w-full"
                  >
                    <option value="0.5">50% - Relaxed</option>
                    <option value="0.7">70% - Balanced</option>
                    <option value="0.8">80% - Strict</option>
                    <option value="0.9">90% - Very Strict</option>
                  </select>
                </div>
              </div>

              <div className="space-y-3">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={preferences.requireConfirmationForAll}
                    onChange={(e) => updatePreferences({ requireConfirmationForAll: e.target.checked })}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700">Require confirmation for all extractions</span>
                </label>

                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={preferences.enableSmartDefaults}
                    onChange={(e) => updatePreferences({ enableSmartDefaults: e.target.checked })}
                    className="mr-2"
                  />
                  <span className="text-sm text-gray-700">Enable smart defaults</span>
                </label>
              </div>

              {/* Compact Bulk Actions */}
              <div className="border-t pt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-3">Quick Actions</h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => applyGlobalSettings('ai')}
                    className="text-xs"
                  >
                    🤖 All AI
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => applyGlobalSettings('pattern')}
                    className="text-xs"
                  >
                    🔍 All Pattern
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => applyGlobalSettings('enable')}
                    className="text-xs"
                  >
                    Enable All
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => applyGlobalSettings('disable')}
                    className="text-xs"
                  >
                    Disable All
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Discover More Fields Section */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <div className="flex items-center">
                  <Icons.Search size="sm" autoContrast className="mr-2" />
                  Discover More Fields
                </div>
                <div className="text-xs text-gray-600">
                  {fieldConfigs.length} configured
                </div>
              </CardTitle>
              <CardDescription className="text-sm">
                Find and add additional Jira fields that can be extracted from your content
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Discovery Actions */}
              <div className="space-y-2">
                <Button
                  onClick={handleDiscoverAllFields}
                  disabled={isScanning}
                  className="jira-btn-primary w-full text-sm"
                  size="sm"
                >
                  {isScanning ? (
                    <>
                      <Icons.Loader size="sm" className="animate-spin mr-2" />
                      Scanning...
                    </>
                  ) : (
                    <>
                      <Icons.Search size="sm" className="mr-2" />
                      Scan All Available Fields
                    </>
                  )}
                </Button>

                {/* Search */}
                <div className="relative">
                  <Icons.Search size="sm" className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search for specific fields..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="jira-input w-full pl-10 text-sm"
                  />
                  {searchTerm && (
                    <Button
                      onClick={handleSearchFields}
                      size="sm"
                      className="absolute right-1 top-1/2 transform -translate-y-1/2"
                    >
                      Search
                    </Button>
                  )}
                </div>
              </div>

              {/* Discovery Error */}
              {discoveryError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <div className="flex items-center">
                    <Icons.AlertCircle size="sm" className="text-red-600 mr-2" />
                    <p className="text-sm text-red-800">{discoveryError}</p>
                  </div>
                </div>
              )}

              {/* Selected Fields Summary */}
              {selectedFields.size > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-blue-800">
                      {selectedFields.size} field(s) selected
                    </span>
                    <Button
                      onClick={handleAddSelectedFields}
                      size="sm"
                      className="jira-btn-primary text-xs"
                    >
                      Add Selected
                    </Button>
                  </div>
                </div>
              )}

              {/* Discovered Fields - Compact Display */}
              {discoveredFields && Object.keys(discoveredFields).some(key => discoveredFields[key as keyof CategorizedFields].length > 0) && (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {/* Commonly Used Fields */}
                  {discoveredFields.commonly_used.length > 0 && (
                    <div className="border border-gray-200 rounded-lg">
                      <div className="bg-gray-50 px-3 py-2 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center text-sm">
                            <Icons.Star size="sm" className="text-yellow-500 mr-2" />
                            <span className="font-medium">Commonly Used ({discoveredFields.commonly_used.length})</span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => selectAllInCategory(discoveredFields.commonly_used)}
                            className="text-xs"
                          >
                            Select All
                          </Button>
                        </div>
                      </div>
                      <div className="p-3 space-y-2">
                        {(expandedCategories.has('commonly_used') || searchTerm.trim() 
                          ? discoveredFields.commonly_used 
                          : discoveredFields.commonly_used.slice(0, 3)
                        ).map(field => (
                          <FieldDiscoveryCard
                            key={field.id}
                            field={field}
                            isSelected={selectedFields.has(field.id)}
                            onToggle={() => toggleFieldSelection(field.id)}
                          />
                        ))}
                        {discoveredFields.commonly_used.length > 3 && !expandedCategories.has('commonly_used') && !searchTerm.trim() && (
                          <button
                            onClick={() => toggleCategoryExpansion('commonly_used')}
                            className="w-full text-xs text-blue-600 hover:text-blue-800 text-center pt-2 transition-colors"
                          >
                            Show {discoveredFields.commonly_used.length - 3} more fields
                          </button>
                        )}
                        {expandedCategories.has('commonly_used') && !searchTerm.trim() && discoveredFields.commonly_used.length > 3 && (
                          <button
                            onClick={() => toggleCategoryExpansion('commonly_used')}
                            className="w-full text-xs text-gray-600 hover:text-gray-800 text-center pt-2 transition-colors"
                          >
                            Show less
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Project Specific Fields */}
                  {discoveredFields.project_specific.length > 0 && (
                    <div className="border border-gray-200 rounded-lg">
                      <div className="bg-gray-50 px-3 py-2 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center text-sm">
                            <Icons.Settings size="sm" className="text-blue-500 mr-2" />
                            <span className="font-medium">Project Specific ({discoveredFields.project_specific.length})</span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => selectAllInCategory(discoveredFields.project_specific)}
                            className="text-xs"
                          >
                            Select All
                          </Button>
                        </div>
                      </div>
                      <div className="p-3 space-y-2">
                        {(expandedCategories.has('project_specific') || searchTerm.trim() 
                          ? discoveredFields.project_specific 
                          : discoveredFields.project_specific.slice(0, 2)
                        ).map(field => (
                          <FieldDiscoveryCard
                            key={field.id}
                            field={field}
                            isSelected={selectedFields.has(field.id)}
                            onToggle={() => toggleFieldSelection(field.id)}
                          />
                        ))}
                        {discoveredFields.project_specific.length > 2 && !expandedCategories.has('project_specific') && !searchTerm.trim() && (
                          <button
                            onClick={() => toggleCategoryExpansion('project_specific')}
                            className="w-full text-xs text-blue-600 hover:text-blue-800 text-center pt-2 transition-colors"
                          >
                            Show {discoveredFields.project_specific.length - 2} more fields
                          </button>
                        )}
                        {expandedCategories.has('project_specific') && !searchTerm.trim() && discoveredFields.project_specific.length > 2 && (
                          <button
                            onClick={() => toggleCategoryExpansion('project_specific')}
                            className="w-full text-xs text-gray-600 hover:text-gray-800 text-center pt-2 transition-colors"
                          >
                            Show less
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Optional Standard Fields */}
                  {discoveredFields.optional_standard.length > 0 && (
                    <div className="border border-gray-200 rounded-lg">
                      <div className="bg-gray-50 px-3 py-2 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center text-sm">
                            <Icons.FileText size="sm" className="text-gray-500 mr-2" />
                            <span className="font-medium">Optional Standard ({discoveredFields.optional_standard.length})</span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => selectAllInCategory(discoveredFields.optional_standard)}
                            className="text-xs"
                          >
                            Select All
                          </Button>
                        </div>
                      </div>
                      <div className="p-3 space-y-2">
                        {(expandedCategories.has('optional_standard') || searchTerm.trim() 
                          ? discoveredFields.optional_standard 
                          : discoveredFields.optional_standard.slice(0, 2)
                        ).map(field => (
                          <FieldDiscoveryCard
                            key={field.id}
                            field={field}
                            isSelected={selectedFields.has(field.id)}
                            onToggle={() => toggleFieldSelection(field.id)}
                          />
                        ))}
                        {discoveredFields.optional_standard.length > 2 && !expandedCategories.has('optional_standard') && !searchTerm.trim() && (
                          <button
                            onClick={() => toggleCategoryExpansion('optional_standard')}
                            className="w-full text-xs text-blue-600 hover:text-blue-800 text-center pt-2 transition-colors"
                          >
                            Show {discoveredFields.optional_standard.length - 2} more fields
                          </button>
                        )}
                        {expandedCategories.has('optional_standard') && !searchTerm.trim() && discoveredFields.optional_standard.length > 2 && (
                          <button
                            onClick={() => toggleCategoryExpansion('optional_standard')}
                            className="w-full text-xs text-gray-600 hover:text-gray-800 text-center pt-2 transition-colors"
                          >
                            Show less
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* System Fields */}
                  {discoveredFields.system_fields.length > 0 && (
                    <div className="border border-gray-200 rounded-lg">
                      <div className="bg-gray-50 px-3 py-2 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center text-sm">
                            <Icons.Settings size="sm" className="text-gray-500 mr-2" />
                            <span className="font-medium">System Fields ({discoveredFields.system_fields.length})</span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => selectAllInCategory(discoveredFields.system_fields)}
                            className="text-xs"
                          >
                            Select All
                          </Button>
                        </div>
                      </div>
                      <div className="p-3 space-y-2">
                        {(expandedCategories.has('system_fields') || searchTerm.trim() 
                          ? discoveredFields.system_fields 
                          : discoveredFields.system_fields.slice(0, 2)
                        ).map(field => (
                          <FieldDiscoveryCard
                            key={field.id}
                            field={field}
                            isSelected={selectedFields.has(field.id)}
                            onToggle={() => toggleFieldSelection(field.id)}
                          />
                        ))}
                        {discoveredFields.system_fields.length > 2 && !expandedCategories.has('system_fields') && !searchTerm.trim() && (
                          <button
                            onClick={() => toggleCategoryExpansion('system_fields')}
                            className="w-full text-xs text-blue-600 hover:text-blue-800 text-center pt-2 transition-colors"
                          >
                            Show {discoveredFields.system_fields.length - 2} more fields
                          </button>
                        )}
                        {expandedCategories.has('system_fields') && !searchTerm.trim() && discoveredFields.system_fields.length > 2 && (
                          <button
                            onClick={() => toggleCategoryExpansion('system_fields')}
                            className="w-full text-xs text-gray-600 hover:text-gray-800 text-center pt-2 transition-colors"
                          >
                            Show less
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

// Field Discovery Card Component
interface FieldDiscoveryCardProps {
  field: DiscoveredField
  isSelected: boolean
  onToggle: () => void
}

function FieldDiscoveryCard({ field, isSelected, onToggle }: FieldDiscoveryCardProps) {
  const getFieldTypeIcon = (type: string) => {
    switch (type.toLowerCase()) {
      case 'select': return '📋'
      case 'multiselect': return '📋'
      case 'user': return '👤'
      case 'date': return '📅'
      case 'number': return '🔢'
      case 'textarea': return '📝'
      default: return '📄'
    }
  }

  const getUsageColor = (percentage: number) => {
    if (percentage >= 80) return 'text-green-600'
    if (percentage >= 60) return 'text-yellow-600'
    return 'text-gray-600'
  }

  return (
    <div 
      className={`border rounded-lg p-3 cursor-pointer transition-all ${
        field.is_configured 
          ? 'border-gray-300 bg-gray-50 opacity-60' 
          : isSelected 
            ? 'border-blue-500 bg-blue-50' 
            : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
      }`}
      onClick={field.is_configured ? undefined : onToggle}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center mb-1">
            <span className="mr-2">{getFieldTypeIcon(field.type)}</span>
            <h4 className="font-medium text-sm text-gray-900">{field.name}</h4>
            {field.required && <span className="text-red-500 text-xs ml-1">*</span>}
          </div>
          
          <div className="text-xs text-gray-600 mb-2">
            {field.id} • {field.type}
            {field.allowedValues && field.allowedValues.length > 0 && (
              <span> • {field.allowedValues.length} options</span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className={`text-xs ${getUsageColor(field.usage_stats.usage_percentage)}`}>
              {field.usage_stats.usage_percentage}% usage
            </div>
            
            {field.usage_stats.is_popular && (
              <Badge variant="outline" className="text-xs px-1 py-0">
                Popular
              </Badge>
            )}
            
            {field.required && (
              <Badge variant="outline" className="text-xs px-1 py-0 border-red-300 text-red-700">
                Required
              </Badge>
            )}
          </div>
        </div>

        <div className="ml-2">
          {field.is_configured ? (
            <div className="flex items-center text-xs text-gray-500">
              <Icons.CheckCircle size="sm" className="text-green-600 mr-1" />
              Configured
            </div>
          ) : (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={onToggle}
              className="w-4 h-4"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      </div>
    </div>
  )
} 