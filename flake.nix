{
  description = "Jellyfin Player for VS Code (unofficial)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      manifest = lib.importJSON ./package.json;

      # Only what the build reads, so editing anything else doesn't trigger a rebuild.
      src = lib.fileset.toSource {
        root = ./.;
        fileset = lib.fileset.unions [
          ./package.json
          ./package-lock.json
          ./esbuild.js
          ./tsconfig.json
          ./.vscodeignore
          ./src
          ./media
          ./README.md
          ./CHANGELOG.md
          ./LICENSE
        ];
      };
    in
    {
      packages = forAllSystems (pkgs: rec {
        # The .vsix file, as `vsce package` makes it; install it with "Extensions: Install from VSIX…".
        vsix = pkgs.buildNpmPackage {
          pname = "${manifest.name}-vsix";
          inherit (manifest) version;
          inherit src;
          npmDeps = pkgs.importNpmLock { npmRoot = src; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          nativeBuildInputs = [ pkgs.vsce ];
          buildPhase = ''
            runHook preBuild
            vsce package --out ${manifest.name}.vsix
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm644 ${manifest.name}.vsix $out/${manifest.name}.vsix
            runHook postInstall
          '';
        };

        # The unpacked extension, for `vscode-with-extensions` or Home Manager's `programs.vscode`.
        default = pkgs.vscode-utils.buildVscodeExtension {
          pname = manifest.name;
          inherit (manifest) version;
          src = "${vsix}/${manifest.name}.vsix";
          vscodeExtPublisher = lib.toLower manifest.publisher;
          vscodeExtName = manifest.name;
          vscodeExtUniqueId = "${lib.toLower manifest.publisher}.${manifest.name}";
          meta = {
            inherit (manifest) description;
            homepage = lib.removeSuffix ".git" manifest.repository.url;
            license = lib.licenses.mit;
          };
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.vsce
          ];
        };
      });
    };
}
