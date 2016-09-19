import { _, DefaultDialogs, Dialogs, Mustache, StringUtils } from "./brackets-modules";
import * as ErrorHandler from "./ErrorHandler";
import * as Events from "./Events";
import EventEmitter from "./EventEmitter";
import * as Git from "./git/Git";
import * as Preferences from "./Preferences";
import * as ProgressDialog from "./dialogs/Progress";
import * as Promise from "bluebird";
import * as PullDialog from "./dialogs/Pull";
import * as PushDialog from "./dialogs/Push";
import * as Strings from "strings";
import * as Utils from "./Utils";

var gitRemotesPickerTemplate = require("text!templates/git-remotes-picker.html");

var $selectedRemote  = null,
    $remotesDropdown = null,
    $gitPanel = null,
    $gitPush = null;

function initVariables() {
    $gitPanel = $("#git-panel");
    $selectedRemote = $gitPanel.find(".git-selected-remote");
    $remotesDropdown = $gitPanel.find(".git-remotes-dropdown");
    $gitPush = $gitPanel.find(".git-push");
}

function getDefaultRemote(allRemotes) {
    var defaultRemotes = Preferences.get("defaultRemotes") || {},
        candidate = defaultRemotes[Preferences.get("currentGitRoot")];

    var exists = _.find(allRemotes, function (remote) {
        return remote.name === candidate;
    });
    if (!exists) {
        candidate = null;
        if (allRemotes.length > 0) {
            candidate = _.first(allRemotes).name;
        }
    }

    return candidate;
}

function setDefaultRemote(remoteName) {
    var defaultRemotes = Preferences.get("defaultRemotes") || {};
    defaultRemotes[Preferences.get("currentGitRoot")] = remoteName;
    Preferences.persist("defaultRemotes", defaultRemotes);
}

function clearRemotePicker() {
    $selectedRemote
        .html("&mdash;")
        .data("remote", null);
}

function selectRemote(remoteName, type) {
    if (!remoteName) {
        return clearRemotePicker();
    }

    // Set as default remote only if is a normal git remote
    if (type === "git") { setDefaultRemote(remoteName); }

    // Disable pull if it is not a normal git remote
    $gitPanel.find(".git-pull").prop("disabled", type !== "git");

    // Enable push and set selected-remote-type to Git push button by type of remote
    $gitPush
        .prop("disabled", false)
        .attr("x-selected-remote-type", type);

    // Update remote name of $selectedRemote
    $selectedRemote
        .text(remoteName)
        .attr("data-type", type) // use attr to apply CSS styles
        .data("remote", remoteName);
}

function refreshRemotesPicker() {
    Git.getRemotes().then(function (remotes) {
        // Set default remote name and cache the remotes dropdown menu
        var defaultRemoteName = getDefaultRemote(remotes);

        // Disable Git-push and Git-pull if there are not remotes defined
        $gitPanel
            .find(".git-pull, .git-push, .git-fetch")
            .prop("disabled", remotes.length === 0);

        // Add options to change remote
        remotes.forEach(function (remote) {
            remote.deletable = remote.name !== "origin";
        });

        // Pass to Mustache the needed data
        var compiledTemplate = Mustache.render(gitRemotesPickerTemplate, {
            Strings: Strings,
            remotes: remotes
        });

        // Inject the rendered template inside the $remotesDropdown
        $remotesDropdown.html(compiledTemplate);

        // Notify others that they may add more stuff to this dropdown
        EventEmitter.emit(Events.REMOTES_REFRESH_PICKER);
        // TODO: is it possible to wait for listeners to finish?

        // TODO: if there're no remotes but there are some ftp remotes
        // we need to adjust that something other may be put as default
        // low priority
        if (remotes.length > 0) {
            selectRemote(defaultRemoteName, "git");
        } else {
            clearRemotePicker();
        }
    }).catch(function (err) {
        ErrorHandler.showError(err, "Getting remotes failed!");
    });
}

function handleRemoteCreation() {
    return Utils.askQuestion(Strings.CREATE_NEW_REMOTE, Strings.ENTER_REMOTE_NAME)
        .then(function (name) {
            return Utils.askQuestion(Strings.CREATE_NEW_REMOTE, Strings.ENTER_REMOTE_URL).then(function (url) {
                return [name, url];
            });
        })
        .spread(function (name, url) {
            return Git.createRemote(name, url).then(function () {
                return refreshRemotesPicker();
            });
        })
        .catch(function (err) {
            if (!ErrorHandler.equals(err, Strings.USER_ABORTED)) {
                ErrorHandler.showError(err, "Remote creation failed");
            }
        });
}

function deleteRemote(remoteName) {
    return Utils.askQuestion(Strings.DELETE_REMOTE, StringUtils.format(Strings.DELETE_REMOTE_NAME, remoteName), { booleanResponse: true })
        .then(function (response) {
            if (response === true) {
                return Git.deleteRemote(remoteName).then(function () {
                    return refreshRemotesPicker();
                });
            }
        })
        .catch(function (err) {
            ErrorHandler.logError(err);
        });
}

function showPushResult(result) {
    if (typeof result.remoteUrl === "string") {
        result.remoteUrl = Utils.encodeSensitiveInformation(result.remoteUrl);
    }

    var template = [
        "<h3>{{flagDescription}}</h3>",
        "Info:",
        "Remote url - {{remoteUrl}}",
        "Local branch - {{from}}",
        "Remote branch - {{to}}",
        "Summary - {{summary}}",
        "<h4>Status - {{status}}</h4>"
    ].join("<br>");

    Dialogs.showModalDialog(
        DefaultDialogs.DIALOG_ID_INFO,
        Strings.GIT_PUSH_RESPONSE, // title
        Mustache.render(template, result) // message
    );
}

function pushToRemote(remote) {
    if (!remote) { return ErrorHandler.showError("No remote has been selected for push!"); }

    var pushConfig = {
        remote: remote
    };

    PushDialog.show(pushConfig)
        .then(function (pushConfig) {
            var q = Promise.resolve(),
                additionalArgs = [];

            if (pushConfig.tags) {
                additionalArgs.push("--tags");
            }

            // set a new tracking branch if desired
            if (pushConfig.branch && pushConfig.setBranchAsTracking) {
                q = q.then(function () {
                    return Git.setUpstreamBranch(pushConfig.remote, pushConfig.branch);
                });
            }
            // put username and password into remote url
            if (pushConfig.remoteUrlNew) {
                q = q.then(function () {
                    return Git.setRemoteUrl(pushConfig.remote, pushConfig.remoteUrlNew);
                });
            }
            // do the pull itself (we are not using pull command)
            q = q.then(function () {
                var op;

                if (pushConfig.pushToNew) {
                    op = Git.pushToNewUpstream(pushConfig.remote, pushConfig.branch);
                } else if (pushConfig.strategy === "DEFAULT") {
                    op = Git.push(pushConfig.remote, pushConfig.branch, additionalArgs);
                } else if (pushConfig.strategy === "FORCED") {
                    op = Git.pushForced(pushConfig.remote, pushConfig.branch);
                } else if (pushConfig.strategy === "DELETE_BRANCH") {
                    op = Git.deleteRemoteBranch(pushConfig.remote, pushConfig.branch);
                }
                return ProgressDialog.show(op)
                    .then(function (result) {
                        return ProgressDialog.waitForClose().then(function () {
                            showPushResult(result);
                        });
                    })
                    .catch(function (err) {
                        ErrorHandler.showError(err, "Pushing to remote failed");
                    });
            });
            // restore original url if desired
            if (pushConfig.remoteUrlRestore) {
                q = q.finally(function () {
                    return Git.setRemoteUrl(pushConfig.remote, pushConfig.remoteUrlRestore);
                });
            }

            return q.finally(function () {
                EventEmitter.emit(Events.REFRESH_ALL);
            });
        })
        .catch(function (err) {
            // when dialog is cancelled, there's no error
            if (err) { ErrorHandler.showError(err, "Pushing operation failed"); }
        });
}

function pullFromRemote(remote) {
    if (!remote) { return ErrorHandler.showError("No remote has been selected for pull!"); }

    var pullConfig = {
        remote: remote
    };

    PullDialog.show(pullConfig)
        .then(function (pullConfig) {
            var q = Promise.resolve();

            // set a new tracking branch if desired
            if (pullConfig.branch && pullConfig.setBranchAsTracking) {
                q = q.then(function () {
                    return Git.setUpstreamBranch(pullConfig.remote, pullConfig.branch);
                });
            }
            // put username and password into remote url
            if (pullConfig.remoteUrlNew) {
                q = q.then(function () {
                    return Git.setRemoteUrl(pullConfig.remote, pullConfig.remoteUrlNew);
                });
            }
            // do the pull itself (we are not using pull command)
            q = q.then(function () {
                // fetch the remote first
                return ProgressDialog.show(Git.fetchRemote(pullConfig.remote))
                    .then(function () {
                        if (pullConfig.strategy === "DEFAULT") {
                            return Git.mergeRemote(pullConfig.remote, pullConfig.branch);
                        } else if (pullConfig.strategy === "AVOID_MERGING") {
                            return Git.mergeRemote(pullConfig.remote, pullConfig.branch, true);
                        } else if (pullConfig.strategy === "MERGE_NOCOMMIT") {
                            return Git.mergeRemote(pullConfig.remote, pullConfig.branch, false, true);
                        } else if (pullConfig.strategy === "REBASE") {
                            return Git.rebaseRemote(pullConfig.remote, pullConfig.branch);
                        } else if (pullConfig.strategy === "RESET") {
                            return Git.resetRemote(pullConfig.remote, pullConfig.branch);
                        }
                    })
                    .then(function (result) {
                        return ProgressDialog.waitForClose().then(function () {
                            return Utils.showOutput(result, Strings.GIT_PULL_RESPONSE);
                        });
                    })
                    .catch(function (err) {
                        ErrorHandler.showError(err, "Pulling from remote failed");
                    });
            });
            // restore original url if desired
            if (pullConfig.remoteUrlRestore) {
                q = q.finally(function () {
                    return Git.setRemoteUrl(pullConfig.remote, pullConfig.remoteUrlRestore);
                });
            }

            return q.finally(function () {
                EventEmitter.emit(Events.REFRESH_ALL);
            });
        })
        .catch(function (err) {
            // when dialog is cancelled, there's no error
            if (err) { ErrorHandler.showError(err, "Pulling operation failed"); }
        });
}

function handleFetch(silent) {

    // Tell the rest of the plugin that the fetch has started
    EventEmitter.emit(Events.FETCH_STARTED);

    var q;

    if (!silent) {

        // If it's not a silent fetch show a progress window
        q = ProgressDialog.show(Git.fetchAllRemotes())
        .catch(function (err) {
            ErrorHandler.showError(err);
        })
        .then(ProgressDialog.waitForClose);

    } else {

        // Else fetch in the background
        q = Git.fetchAllRemotes()
        .catch(function (err) {
            ErrorHandler.logError(err);
        });

    }

    // Tell the rest of the plugin that the fetch has completed
    return q.finally(function () {
        EventEmitter.emit(Events.FETCH_COMPLETE);
    });
}

// Event subscriptions
EventEmitter.on(Events.GIT_ENABLED, function () {
    initVariables();
    refreshRemotesPicker();
});
EventEmitter.on(Events.HANDLE_REMOTE_PICK, function (event) {
    var $remote     = $(event.target).closest(".remote-name"),
        remoteName  = $remote.data("remote-name"),
        type        = $remote.data("type");
    selectRemote(remoteName, type);
    EventEmitter.emit(Events.REFRESH_COUNTERS);
});
EventEmitter.on(Events.HANDLE_REMOTE_CREATE, function () {
    handleRemoteCreation();
});
EventEmitter.on(Events.HANDLE_REMOTE_DELETE, function (event) {
    var remoteName = $(event.target).closest(".remote-name").data("remote-name");
    deleteRemote(remoteName);
});
EventEmitter.on(Events.HANDLE_PULL, function () {
    var remoteName = $selectedRemote.data("remote");
    pullFromRemote(remoteName);
});
EventEmitter.on(Events.HANDLE_PUSH, function () {
    var remoteName = $selectedRemote.data("remote");
    pushToRemote(remoteName);
});
EventEmitter.on(Events.HANDLE_FETCH, function () {
    handleFetch();
});
