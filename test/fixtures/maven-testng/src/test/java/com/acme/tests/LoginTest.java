package com.acme.tests;
import org.testng.annotations.Test;
public class LoginTest extends com.acme.base.BaseTest {
  @Test(groups = {"smoke"})
  public void validLogin() {}
  @Test(groups = {"regression"}, priority = 2)
  public void invalidLogin() {}
}
