const current_dir = path self .

# Create a symlink
def symlink [
    existing: path   # The existing file
    new_link_name: path  # The name of the symlink
    --force(-f)     # if target exists moves it to
] {
    print $"(ansi purple_bold)Creating symlink(ansi reset) ($existing) --> ($new_link_name)"
    let existing = ($existing | path expand --strict | path split | path join)
    let $new_link_name = ($new_link_name | path expand --no-symlink | path split | path join)


    # create parent folder if it doesn't exist
    mkdir ($new_link_name | path dirname)

    if ($force and ($new_link_name | path exists)) {
       rm --recursive $new_link_name
    }

    if $nu.os-info.family == 'windows' {
        if ($existing | path type) == 'dir' {
            mklink /D $new_link_name $existing
        } else {
            mklink $new_link_name $existing
        }
    } else {
        ln -s $existing $new_link_name | ignore
    }
}

def complete_settings [] { ['settings-kilo.json' 'settings-copilot.json'] }
const choice_file = 'settings.choice'

export def "config pi" [settings_json: string@complete_settings] {
    print $"(ansi pi)symlinking ($current_dir) -> ~/.pi(ansi reset)"
    symlink --force $current_dir ~/.pi
    cd ($current_dir | path join agent)
    let choice_file = 'settings.choice'
    print $"(ansi pi)saving choice ($settings_json) -> ($choice_file)(ansi reset)"
    $settings_json | save --force $choice_file
    print $"(ansi pi)copying ($settings_json) -> settings.json(ansi reset)"
    cp --force $settings_json settings.json
}

export def "sync settings" [] {
    cd ($current_dir | path join agent)
    let choice_file = 'settings.choice'
    if not ($choice_file | path exists) { error make { msg: "settings.choice missing" } }
    let settings_json = (open $choice_file | str trim)
    print $"(ansi pi)syncing settings.json -> ($settings_json)(ansi reset)"
    cp --force settings.json $settings_json
}

export def "npm install all" [] {
    for x in (glob agent/{extensions,skills}/*/package.json) {
        print $"(ansi purple_bold)($x)(ansi reset)"
        cd ($x | path dirname)
        print $"(ansi pi)npm install --ignore-scripts(ansi reset)"
        npm install --ignore-scripts
    }
}

export def bootstrap [settings_json: string@complete_settings] {
    config pi $settings_json
    npm install all
}

export def main [] {
    print "Available commands:"
    print "  config pi <settings_json>   - configure pi (symlink + settings)"
    print "  sync settings              - sync settings.json to template (from choice)"
    print "  bootstrap <settings_json>   - config pi + npm install all"
    print "  npm install all            - install npm deps"
}
