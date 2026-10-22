Pod::Spec.new do |s|
  s.name           = 'TasteLink'
  s.version        = '0.1.0'
  s.summary        = 'The encrypted link between the TasteCode phone app and its computer'
  s.description    = 'Noise IK over a WebSocket on the local network or a tailnet.'
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
