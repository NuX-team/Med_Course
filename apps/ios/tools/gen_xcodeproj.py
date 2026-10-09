#!/usr/bin/env python3
"""Writes MedCourse.xcodeproj/project.pbxproj from the Swift files on disk.

The project is generated, not hand-edited: add a .swift file under MedCourse/, run
`python3 apps/ios/tools/gen_xcodeproj.py`, commit both. Ids are derived from paths, so the
output is stable and diffs stay small.
"""
import hashlib
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "MedCourse")
OUT = os.path.join(ROOT, "MedCourse.xcodeproj")

BUNDLE_ID = "uz.medcourse.app"
DEPLOYMENT = "17.0"


def uid(*parts):
    return hashlib.sha1("/".join(parts).encode()).hexdigest()[:24].upper()


swift = []
for dirpath, _, files in os.walk(SRC):
    for name in sorted(files):
        if name.endswith(".swift"):
            swift.append(os.path.relpath(os.path.join(dirpath, name), SRC))
swift.sort()

groups = {}  # "Core" -> [files]
for path in swift:
    folder = os.path.dirname(path)
    groups.setdefault(folder, []).append(path)

PROJECT = uid("project")
TARGET = uid("target")
MAIN_GROUP = uid("group", "main")
APP_GROUP = uid("group", "MedCourse")
PRODUCTS = uid("group", "products")
PRODUCT = uid("product")
SOURCES_PHASE = uid("phase", "sources")
RESOURCES_PHASE = uid("phase", "resources")
FRAMEWORKS_PHASE = uid("phase", "frameworks")
PROJECT_CONFIGS = uid("configlist", "project")
TARGET_CONFIGS = uid("configlist", "target")
ASSETS = uid("file", "Assets.xcassets")
ASSETS_BUILD = uid("build", "Assets.xcassets")
PLIST = uid("file", "Info.plist")

lines = []
w = lines.append

w("// !$*UTF8*$!")
w("{")
w("\tarchiveVersion = 1;")
w("\tclasses = {")
w("\t};")
w("\tobjectVersion = 56;")
w("\tobjects = {")
w("")
w("/* Begin PBXBuildFile section */")
for path in swift:
    w(f"\t\t{uid('build', path)} /* {os.path.basename(path)} in Sources */ = {{isa = PBXBuildFile; fileRef = {uid('file', path)} /* {os.path.basename(path)} */; }};")
w(f"\t\t{ASSETS_BUILD} /* Assets.xcassets in Resources */ = {{isa = PBXBuildFile; fileRef = {ASSETS} /* Assets.xcassets */; }};")
w("/* End PBXBuildFile section */")
w("")
w("/* Begin PBXFileReference section */")
for path in swift:
    name = os.path.basename(path)
    w(f"\t\t{uid('file', path)} /* {name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {name}; sourceTree = \"<group>\"; }};")
w(f"\t\t{ASSETS} /* Assets.xcassets */ = {{isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = \"<group>\"; }};")
w(f"\t\t{PLIST} /* Info.plist */ = {{isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = \"<group>\"; }};")
w(f"\t\t{PRODUCT} /* MedCourse.app */ = {{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = MedCourse.app; sourceTree = BUILT_PRODUCTS_DIR; }};")
w("/* End PBXFileReference section */")
w("")
w("/* Begin PBXFrameworksBuildPhase section */")
w(f"\t\t{FRAMEWORKS_PHASE} /* Frameworks */ = {{")
w("\t\t\tisa = PBXFrameworksBuildPhase;")
w("\t\t\tbuildActionMask = 2147483647;")
w("\t\t\tfiles = (")
w("\t\t\t);")
w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
w("\t\t};")
w("/* End PBXFrameworksBuildPhase section */")
w("")
w("/* Begin PBXGroup section */")
w(f"\t\t{MAIN_GROUP} = {{")
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
w(f"\t\t\t\t{APP_GROUP} /* MedCourse */,")
w(f"\t\t\t\t{PRODUCTS} /* Products */,")
w("\t\t\t);")
w("\t\t\tsourceTree = \"<group>\";")
w("\t\t};")
w(f"\t\t{PRODUCTS} /* Products */ = {{")
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
w(f"\t\t\t\t{PRODUCT} /* MedCourse.app */,")
w("\t\t\t);")
w("\t\t\tname = Products;")
w("\t\t\tsourceTree = \"<group>\";")
w("\t\t};")
w(f"\t\t{APP_GROUP} /* MedCourse */ = {{")
w("\t\t\tisa = PBXGroup;")
w("\t\t\tchildren = (")
for folder in sorted(groups):
    if folder:
        w(f"\t\t\t\t{uid('group', folder)} /* {folder} */,")
for path in groups.get("", []):
    w(f"\t\t\t\t{uid('file', path)} /* {os.path.basename(path)} */,")
w(f"\t\t\t\t{ASSETS} /* Assets.xcassets */,")
w(f"\t\t\t\t{PLIST} /* Info.plist */,")
w("\t\t\t);")
w("\t\t\tpath = MedCourse;")
w("\t\t\tsourceTree = \"<group>\";")
w("\t\t};")
for folder in sorted(groups):
    if not folder:
        continue
    w(f"\t\t{uid('group', folder)} /* {folder} */ = {{")
    w("\t\t\tisa = PBXGroup;")
    w("\t\t\tchildren = (")
    for path in groups[folder]:
        w(f"\t\t\t\t{uid('file', path)} /* {os.path.basename(path)} */,")
    w("\t\t\t);")
    w(f"\t\t\tpath = {folder};")
    w("\t\t\tsourceTree = \"<group>\";")
    w("\t\t};")
w("/* End PBXGroup section */")
w("")
w("/* Begin PBXNativeTarget section */")
w(f"\t\t{TARGET} /* MedCourse */ = {{")
w("\t\t\tisa = PBXNativeTarget;")
w(f"\t\t\tbuildConfigurationList = {TARGET_CONFIGS} /* Build configuration list for PBXNativeTarget \"MedCourse\" */;")
w("\t\t\tbuildPhases = (")
w(f"\t\t\t\t{SOURCES_PHASE} /* Sources */,")
w(f"\t\t\t\t{FRAMEWORKS_PHASE} /* Frameworks */,")
w(f"\t\t\t\t{RESOURCES_PHASE} /* Resources */,")
w("\t\t\t);")
w("\t\t\tbuildRules = (")
w("\t\t\t);")
w("\t\t\tdependencies = (")
w("\t\t\t);")
w("\t\t\tname = MedCourse;")
w("\t\t\tproductName = MedCourse;")
w(f"\t\t\tproductReference = {PRODUCT} /* MedCourse.app */;")
w("\t\t\tproductType = \"com.apple.product-type.application\";")
w("\t\t};")
w("/* End PBXNativeTarget section */")
w("")
w("/* Begin PBXProject section */")
w(f"\t\t{PROJECT} /* Project object */ = {{")
w("\t\t\tisa = PBXProject;")
w("\t\t\tattributes = {")
w("\t\t\t\tBuildIndependentTargetsInParallel = 1;")
w("\t\t\t\tLastSwiftUpdateCheck = 1540;")
w("\t\t\t\tLastUpgradeCheck = 1540;")
w("\t\t\t\tTargetAttributes = {")
w(f"\t\t\t\t\t{TARGET} = {{")
w("\t\t\t\t\t\tCreatedOnToolsVersion = 15.4;")
w("\t\t\t\t\t};")
w("\t\t\t\t};")
w("\t\t\t};")
w(f"\t\t\tbuildConfigurationList = {PROJECT_CONFIGS} /* Build configuration list for PBXProject \"MedCourse\" */;")
w("\t\t\tcompatibilityVersion = \"Xcode 14.0\";")
w("\t\t\tdevelopmentRegion = ru;")
w("\t\t\thasScannedForEncodings = 0;")
w("\t\t\tknownRegions = (")
w("\t\t\t\tru,")
w("\t\t\t\tuz,")
w("\t\t\t\tBase,")
w("\t\t\t);")
w(f"\t\t\tmainGroup = {MAIN_GROUP};")
w(f"\t\t\tproductRefGroup = {PRODUCTS} /* Products */;")
w("\t\t\tprojectDirPath = \"\";")
w("\t\t\tprojectRoot = \"\";")
w("\t\t\ttargets = (")
w(f"\t\t\t\t{TARGET} /* MedCourse */,")
w("\t\t\t);")
w("\t\t};")
w("/* End PBXProject section */")
w("")
w("/* Begin PBXResourcesBuildPhase section */")
w(f"\t\t{RESOURCES_PHASE} /* Resources */ = {{")
w("\t\t\tisa = PBXResourcesBuildPhase;")
w("\t\t\tbuildActionMask = 2147483647;")
w("\t\t\tfiles = (")
w(f"\t\t\t\t{ASSETS_BUILD} /* Assets.xcassets in Resources */,")
w("\t\t\t);")
w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
w("\t\t};")
w("/* End PBXResourcesBuildPhase section */")
w("")
w("/* Begin PBXSourcesBuildPhase section */")
w(f"\t\t{SOURCES_PHASE} /* Sources */ = {{")
w("\t\t\tisa = PBXSourcesBuildPhase;")
w("\t\t\tbuildActionMask = 2147483647;")
w("\t\t\tfiles = (")
for path in swift:
    w(f"\t\t\t\t{uid('build', path)} /* {os.path.basename(path)} in Sources */,")
w("\t\t\t);")
w("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
w("\t\t};")
w("/* End PBXSourcesBuildPhase section */")
w("")

common_project = {
    "ALWAYS_SEARCH_USER_PATHS": "NO",
    "CLANG_ENABLE_MODULES": "YES",
    "CLANG_ENABLE_OBJC_ARC": "YES",
    "ENABLE_STRICT_OBJC_MSGSEND": "YES",
    "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
    "GCC_NO_COMMON_BLOCKS": "YES",
    "IPHONEOS_DEPLOYMENT_TARGET": DEPLOYMENT,
    "SDKROOT": "iphoneos",
    "SWIFT_VERSION": "5.0",
}
debug_project = dict(common_project, **{
    "DEBUG_INFORMATION_FORMAT": "dwarf",
    "ENABLE_TESTABILITY": "YES",
    "GCC_OPTIMIZATION_LEVEL": "0",
    "ONLY_ACTIVE_ARCH": "YES",
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG",
    "SWIFT_OPTIMIZATION_LEVEL": "\"-Onone\"",
})
release_project = dict(common_project, **{
    "DEBUG_INFORMATION_FORMAT": "\"dwarf-with-dsym\"",
    "SWIFT_COMPILATION_MODE": "wholemodule",
    "VALIDATE_PRODUCT": "YES",
})
target = {
    "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
    "ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME": "AccentColor",
    "CODE_SIGN_STYLE": "Automatic",
    "CURRENT_PROJECT_VERSION": "1",
    "DEVELOPMENT_TEAM": "\"\"",
    "GENERATE_INFOPLIST_FILE": "NO",
    "INFOPLIST_FILE": "MedCourse/Info.plist",
    "LD_RUNPATH_SEARCH_PATHS": "(\n\t\t\t\t\t\"$(inherited)\",\n\t\t\t\t\t\"@executable_path/Frameworks\",\n\t\t\t\t)",
    "MARKETING_VERSION": "1.0",
    "PRODUCT_BUNDLE_IDENTIFIER": BUNDLE_ID,
    "PRODUCT_NAME": "\"$(TARGET_NAME)\"",
    "SUPPORTED_PLATFORMS": "\"iphoneos iphonesimulator\"",
    "SUPPORTS_MACCATALYST": "NO",
    "TARGETED_DEVICE_FAMILY": "1",
    "API_BASE_URL": "\"https://api.medcourse.uz\"",
    "BOT_USERNAME": "fkmzh",
}
target_debug = dict(target, API_BASE_URL="\"http://localhost:3003\"")


def config(ident, name, settings):
    w(f"\t\t{ident} /* {name} */ = {{")
    w("\t\t\tisa = XCBuildConfiguration;")
    w("\t\t\tbuildSettings = {")
    for key in sorted(settings):
        w(f"\t\t\t\t{key} = {settings[key]};")
    w("\t\t\t};")
    w(f"\t\t\tname = {name};")
    w("\t\t};")


w("/* Begin XCBuildConfiguration section */")
config(uid("config", "project", "Debug"), "Debug", debug_project)
config(uid("config", "project", "Release"), "Release", release_project)
config(uid("config", "target", "Debug"), "Debug", target_debug)
config(uid("config", "target", "Release"), "Release", target)
w("/* End XCBuildConfiguration section */")
w("")
w("/* Begin XCConfigurationList section */")
for ident, owner, kind in [
    (PROJECT_CONFIGS, "project", "PBXProject"),
    (TARGET_CONFIGS, "target", "PBXNativeTarget"),
]:
    w(f"\t\t{ident} /* Build configuration list for {kind} \"MedCourse\" */ = {{")
    w("\t\t\tisa = XCConfigurationList;")
    w("\t\t\tbuildConfigurations = (")
    w(f"\t\t\t\t{uid('config', owner, 'Debug')} /* Debug */,")
    w(f"\t\t\t\t{uid('config', owner, 'Release')} /* Release */,")
    w("\t\t\t);")
    w("\t\t\tdefaultConfigurationIsVisible = 0;")
    w("\t\t\tdefaultConfigurationName = Release;")
    w("\t\t};")
w("/* End XCConfigurationList section */")
w("\t};")
w(f"\trootObject = {PROJECT} /* Project object */;")
w("}")

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "project.pbxproj"), "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(lines) + "\n")

workspace = os.path.join(OUT, "project.xcworkspace")
os.makedirs(workspace, exist_ok=True)
with open(os.path.join(workspace, "contents.xcworkspacedata"), "w", encoding="utf-8") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<Workspace\n   version = "1.0">\n   <FileRef\n      location = "self:">\n   </FileRef>\n</Workspace>\n')

schemes = os.path.join(OUT, "xcshareddata", "xcschemes")
os.makedirs(schemes, exist_ok=True)
ref = f'''            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "{TARGET}"
               BuildableName = "MedCourse.app"
               BlueprintName = "MedCourse"
               ReferencedContainer = "container:MedCourse.xcodeproj">
            </BuildableReference>'''
with open(os.path.join(schemes, "MedCourse.xcscheme"), "w", encoding="utf-8") as f:
    f.write(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1540"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
{ref}
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
{ref}
      </BuildableProductRunnable>
   </LaunchAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
''')
print(f"wrote {len(swift)} sources into {os.path.relpath(OUT, ROOT)}")
