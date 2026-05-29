import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Der Pfad zum aktuellen Repository wird als erstes Argument übergeben,
// ansonsten nehmen wir den aktuellen Ordner (CWD)
const targetDir = process.argv[2] || process.cwd();
const pomPath = join(targetDir, 'pom.xml');

// Die Dependency, die wir per Bulk ausrollen wollen
const dependencyToAdd = `
    <dependency>
        <groupId>org.apache.commons</groupId>
        <artifactId>commons-lang3</artifactId>
        <version>3.14.0</version>
    </dependency>`;

console.log(`[Change-Script] Prüfe pom.xml in: ${targetDir}`);

// 1. Gibt es überhaupt eine pom.xml? (z.B. im Frontend-Repo gibt es keine)
if (!existsSync(pomPath)) {
  console.log(' -> Keine pom.xml gefunden. Überspringe Repo...');
  process.exit(0); // Exit Code 0, da es kein echter Fehler ist, sondern ein gewollter Skip
}

let pomContent = readFileSync(pomPath, 'utf8');

// 2. Idempotenz-Check: Ist die Dependency schon drin?
if (pomContent.includes('<artifactId>commons-lang3</artifactId>')) {
  console.log(' -> commons-lang3 ist bereits vorhanden. Nichts zu tun.');
  process.exit(0);
}

// 3. Hat die pom.xml schon einen <dependencies> Block?
if (pomContent.includes('</dependencies>')) {
  // Wenn ja, füge die Dependency vor dem schliessenden Tag ein
  pomContent = pomContent.replace('</dependencies>', `${dependencyToAdd}\n    </dependencies>`);
  console.log(' -> Dependency in bestehenden <dependencies> Block eingefügt.');
} else {
  // Wenn nein, erstelle den Block vor dem schliessenden </project> Tag
  const newDependenciesBlock = `
    <dependencies>${dependencyToAdd}
    </dependencies>
</project>`;

  pomContent = pomContent.replace('</project>', newDependenciesBlock);
  console.log(' -> Neuer <dependencies> Block erstellt und Dependency eingefügt.');
}

// 4. Datei speichern
writeFileSync(pomPath, pomContent, 'utf8');
console.log(' -> pom.xml erfolgreich aktualisiert!');
