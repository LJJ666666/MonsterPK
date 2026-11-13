@echo off
setlocal
cd /d "%~dp0" || (echo Cannot locate repo directory & pause & exit /b 1)

echo ============================================
echo  MonsterPK - push to GitHub (host network)
echo  Repo: %CD%
echo ============================================
echo.
echo [1] Fetching origin ...
git fetch origin --tags --quiet
echo.
echo [2] Status vs origin/master:
git status -sb
echo.
echo [3] Commits ahead of origin/master:
git log --oneline origin/master..HEAD
echo.
echo [4] Pushing master + tags ...
git push origin master --tags
if %errorlevel%==0 (
  echo.
  echo [OK] Push succeeded.
  git ls-remote origin master
) else (
  echo.
  echo [FAIL] Push failed, see errors above.
)
echo.
pause
