Pod::Spec.new do |s|
  s.name           = 'TasteUI'
  s.version        = '0.1.0'
  s.summary        = 'The TasteCode phone app\'s native screens'
  s.description    = 'Every screen of the phone app in UIKit, in one native view that Expo hosts.'
  s.license        = 'Apache-2.0'
  s.author         = 'TasteCode'
  s.homepage       = 'https://github.com/Leonxlnx/tastecode'
  s.platforms      = { :ios => '26.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
